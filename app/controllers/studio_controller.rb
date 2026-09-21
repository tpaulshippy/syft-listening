require "net/http"
require "uri"
require "json"

# Generalized voice UI studio — the same parallel fan-out pattern as Builder,
# but data-agnostic: the question set is generated from the dataset's own
# schema instead of being hardcoded for tasks/calendar.
#
# State = { request, schema: { columns: [{name}] }, rows }.
# Questions = one fixed `view` choice over the component registry + dynamic
# field-binding choices whose options are the dataset's actual columns
# (positional col0, col1, … with real names plus sample values in the
# criteria text, so Jev judges fit from evidence; Choice supports up to 255
# options) + feature nouls + one include_col<i> noul per column (the fan-out
# that scales with data width) + Jev-native row filter: `filter_column` /
# `filter_op` choices plus one `filter_value_col<i>` choice per
# low-cardinality column (Jev can't emit free text, so values are enumerated)
# plus a `filter_negate` noul for exclusions ("not", "except").
# The frontend (`studio_controller.js`) is a generic interpreter: it maps the
# winning spec onto Chart.js (bar/line/pie/scatter/bubbles) or hand-rendered
# table/cards/kpi DOM. Jev selects parameters; it never invents components.
class StudioController < ApplicationController
  JEV_URL = "https://api.typesafe.ai/v1/systemone".freeze
  JEV_MODEL = "jev-latest".freeze
  MAX_ROWS = 25
  MAX_COLUMNS = 60
  MAX_STATE_BYTES = 12_000

  # Three arbitrary demo datasets proving the renderer is not task-specific.
  SAMPLES = {
    "bookstore" => [
      { title: "The Midnight Library", genre: "fiction", units: 42, revenue: 756.0, month: "2026-06" },
      { title: "Atomic Habits", genre: "nonfiction", units: 67, revenue: 1206.0, month: "2026-06" },
      { title: "Dune", genre: "scifi", units: 35, revenue: 665.0, month: "2026-06" },
      { title: "The Midnight Library", genre: "fiction", units: 51, revenue: 918.0, month: "2026-07" },
      { title: "Atomic Habits", genre: "nonfiction", units: 58, revenue: 1044.0, month: "2026-07" },
      { title: "Dune", genre: "scifi", units: 44, revenue: 836.0, month: "2026-07" },
      { title: "Project Hail Mary", genre: "scifi", units: 39, revenue: 741.0, month: "2026-07" },
      { title: "Sapiens", genre: "nonfiction", units: 29, revenue: 522.0, month: "2026-07" }
    ],
    "workouts" => [
      { date: "2026-09-01", activity: "run", minutes: 32, km: 5.1, effort: 7 },
      { date: "2026-09-03", activity: "swim", minutes: 45, km: 1.5, effort: 6 },
      { date: "2026-09-05", activity: "run", minutes: 58, km: 9.2, effort: 8 },
      { date: "2026-09-08", activity: "bike", minutes: 75, km: 22.4, effort: 6 },
      { date: "2026-09-10", activity: "run", minutes: 28, km: 4.6, effort: 5 },
      { date: "2026-09-12", activity: "gym", minutes: 50, km: 0, effort: 7 }
    ],
    "incidents" => [
      { id: "INC-101", service: "checkout", severity: "critical", minutes_open: 47, status: "resolved", owner: "priya" },
      { id: "INC-102", service: "search", severity: "minor", minutes_open: 120, status: "open", owner: "sam" },
      { id: "INC-103", service: "checkout", severity: "major", minutes_open: 25, status: "open", owner: "maya" },
      { id: "INC-104", service: "billing", severity: "major", minutes_open: 63, status: "resolved", owner: "you" },
      { id: "INC-105", service: "search", severity: "minor", minutes_open: 15, status: "resolved", owner: "you" }
    ]
  }.freeze

  VIEWS = %w[table cards kpi bar line pie scatter bubbles].freeze
  # Panels beyond the first use suffixed keys (view_2, x_field_2, …).
  # Panel 1 keeps the un-suffixed keys. The renderer ignores panels past
  # panel_count (speculative fan-out: Jev answers everything anyway).
  MAX_PANELS = 3
  ORDINALS = { 2 => "second", 3 => "third" }.freeze

  def show
  end

  # POST /jev_studio — Body: { prompt, dataset (array of objects) or sample,
  # api_key }. Builds schema-driven questions, fans out to Jev once.
  def analyze
    prompt = params[:prompt].to_s.strip
    api_key = params[:api_key].to_s.strip.presence || ENV["TYPESAFE_API_KEY"].to_s.strip.presence
    rows = extract_rows

    return render json: { error: "No request provided" }, status: :bad_request if prompt.blank?
    return render json: { error: rows[:error] }, status: :bad_request if rows[:error]
    return render json: { error: "Missing Jev API key. Paste your TypeSafe key to build." }, status: :unauthorized if api_key.blank?

    schema = infer_schema(rows[:rows])
    questions = build_questions(schema, rows[:rows])
    payload = {
      model: JEV_MODEL,
      state: {
        request: prompt,
        schema: schema,
        rows: rows[:rows].first(MAX_ROWS)
      },
      questions: questions
    }
    # Keep state small: truncate serialized rows if needed (schema stays whole).
    payload[:state][:rows] = truncate_rows(payload[:state][:rows]) if payload.to_json.bytesize > MAX_STATE_BYTES * 4
    post_to_jev(payload, api_key, questions.size, schema)
  end

  # POST /jev_command — voice command router for the studio page.
  # Body: { transcript, current_tab, fields ([{id, name}]), row_count,
  # columns ([names]), api_key }. Jev decides everything: which tab
  # (destination choice), which field (design_target choice over field ids
  # plus new_field), and which row (row_target choice over row_1..row_N plus
  # new_row). The transcript itself is never inspected here — it rides in
  # state and only Jev reads it. A visualize destination means the transcript
  # is the render prompt verbatim (carried, never parsed).
  MAX_COMMAND_ROWS = 50

  def command
    transcript = params[:transcript].to_s.strip
    api_key = params[:api_key].to_s.strip.presence || ENV["TYPESAFE_API_KEY"].to_s.strip.presence
    return render json: { error: "No transcript provided" }, status: :bad_request if transcript.blank?
    return render json: { error: "Missing Jev API key. Paste your TypeSafe key for voice commands." }, status: :unauthorized if api_key.blank?

    fields = command_fields
    return render json: { error: fields[:error] }, status: :bad_request if fields[:error]
    rows = command_row_count
    return render json: { error: rows[:error] }, status: :bad_request if rows[:error]
    columns = command_columns

    current_tab = params[:current_tab].to_s.strip
    current_tab = "design" if current_tab.empty?
    unless %w[design input visualize].include?(current_tab)
      return render json: { error: "Unknown tab (expected design, input, visualize)" }, status: :bad_request
    end

    questions = command_questions(fields[:fields], rows[:count], columns)
    payload = {
      model: JEV_MODEL,
      state: {
        transcript: transcript,
        current_tab: current_tab,
        fields: fields[:fields].map { |f| f[:name] },
        row_count: rows[:count],
        columns: columns
      },
      questions: questions
    }
    post_to_jev(payload, api_key, questions.size, { columns: [], row_count: rows[:count] })
  end

  private

  def command_fields
    raw = params[:fields]
    return { fields: [] } if raw.nil? || (raw.is_a?(String) && raw.strip.empty?)

    parsed = raw.is_a?(Array) ? raw : parse_command_json(raw.to_s)
    return parsed if parsed.is_a?(Hash) && parsed[:error]
    return { error: "Fields must be an array" } unless parsed.is_a?(Array)

    fields = parsed.first(MAX_COLUMNS).map do |f|
      h = f.respond_to?(:to_unsafe_h) ? f.to_unsafe_h : f.to_h
      { id: h["id"].to_s.strip, name: h["name"].to_s.strip }
    end
    fields = fields.reject { |f| f[:id].empty? || f[:name].empty? }
    { fields: fields }
  end

  def command_row_count
    raw = params[:row_count]
    return { count: 0 } if raw.nil? || raw.to_s.strip.empty?

    count = raw.to_i
    return { error: "Row count must be 0 or more" } if count.negative?
    return { error: "Row count too large (max #{MAX_COMMAND_ROWS * 4})" } if count > MAX_COMMAND_ROWS * 4

    { count: count }
  end

  def command_columns
    raw = params[:columns]
    return [] if raw.nil? || (raw.is_a?(String) && raw.strip.empty?)

    parsed = raw.is_a?(Array) ? raw : parse_command_json(raw.to_s)
    return [] unless parsed.is_a?(Array)

    parsed.map(&:to_s).map(&:strip).reject(&:empty?).first(MAX_COLUMNS)
  end

  def parse_command_json(raw)
    JSON.parse(raw)
  rescue JSON::ParserError
    { error: "Fields/columns must be a JSON array" }
  end

  def command_questions(fields, row_count, columns)
    design_criteria = { "new_field" => "The speaker wants to create or add a new field",
                        "none" => "No design action — the speaker wants something else" }
    fields.each do |f|
      design_criteria[f[:id]] = "`transcript` means the field \"#{f[:name]}\""
    end
    row_criteria = { "new_row" => "The speaker wants to add a new row",
                     "none" => "No row action — the speaker wants something else" }
    [ row_count, MAX_COMMAND_ROWS ].min.times do |i|
      n = (i + 1).to_s
      row_criteria["row_#{n}"] = "`transcript` means row #{n}"
    end
    {
      "destination" => {
        type: "choice",
        instructions: "Which studio tab does the speaker want in `transcript` (currently on `current_tab`, fields `fields`, `row_count` rows, columns `columns`)?",
        criteria: {
          design: "Design fields — creating a field, renaming, changing a type, options, or required",
          input: "Input rows — adding a row, filling answers, editing or deleting a row",
          visualize: "Visualize the data — a chart, table, cards, KPIs, totals, or trend over the columns"
        }
      },
      "design_target" => {
        type: "choice",
        instructions: "If the speaker wants the design tab, which field does `transcript` name? (used only then)",
        criteria: design_criteria
      },
      "row_target" => {
        type: "choice",
        instructions: "If the speaker wants the input tab, which row does `transcript` name? (used only then)",
        criteria: row_criteria
      }
    }
  end

  def extract_rows
    if params[:sample].to_s.strip.present?
      rows = SAMPLES[params[:sample].to_s.strip]
      return { error: "Unknown sample dataset" } unless rows

      return { rows: rows }
    end
    raw = params[:dataset]
    # fetch() posts a JSON body, so Rails usually parses this into an Array
    # already; the String branch covers form-encoded posts and specs.
    parsed = raw.is_a?(Array) ? raw : parse_dataset_json(raw.to_s.strip)
    return parsed if parsed.is_a?(Hash) && parsed[:error]
    return { error: "Dataset must be an array of objects" } unless parsed.is_a?(Array) && parsed.all? { |r| hash_like?(r) }
    return { error: "Dataset is empty" } if parsed.empty?
    return { error: "Dataset too large (max 500 rows)" } if parsed.size > 500

    { rows: parsed.first(MAX_ROWS * 4).map { |r| r.respond_to?(:to_unsafe_h) ? r.to_unsafe_h : r.to_h } }
  end

  def hash_like?(value)
    value.is_a?(Hash) || value.is_a?(ActionController::Parameters)
  end

  def parse_dataset_json(raw)
    return { error: "No dataset provided (paste a JSON array of objects)" } if raw.blank?

    begin
      JSON.parse(raw)
    rescue JSON::ParserError
      { error: "Dataset is not valid JSON (expected an array of objects)" }
    end
  end

  # Column names in order. There are no inferred types and no slug transform:
  # bindings are positional (col0, col1, …) with the real name — plus sample
  # values — in the criteria text, so Jev judges from evidence.
  def infer_schema(rows)
    names = rows.each_with_object([]) { |row, acc| row.each_key { |k| acc << k.to_s unless acc.include?(k.to_s) } }
    names = names.first(MAX_COLUMNS)
    columns = names.map { |name| { name: name } }
    { columns: columns, row_count: rows.size }
  end

  def truncate_rows(rows)
    rows.first(10)
  end

  # Positional bindings (col0, col1, …): the real name plus sample values go
  # in the criteria text, so Jev judges numeric-ness and fit from evidence.
  # Nothing here inspects characters — values are read, never parsed.
  def column_ref(index)
    "col#{index}"
  end

  def sample_values(name, rows)
    seen = []
    rows.each do |row|
      v = row[name].nil? ? row[name.to_sym] : row[name]
      next if v.nil?
      s = v.to_s
      next if s.strip.empty? || seen.include?(s)
      seen << s
      break if seen.size >= 3
    end
    seen
  end

  def option_map(columns, rows)
    columns.each_with_index.each_with_object({}) do |(col, i), h|
      samples = sample_values(col[:name], rows)
      label = "`#{col[:name]}`"
      label += " e.g. #{samples.join(', ')}" if samples.any?
      h[column_ref(i)] = label
    end
  end

  def build_questions(schema, rows)
    columns = schema[:columns]
    options = option_map(columns, rows)

    questions = {
      "layout" => {
        type: "choice",
        instructions: "If `request` asks for more than one panel, how should they be arranged?",
        criteria: {
          single: "One panel only (or panels are irrelevant)",
          stack: "Panels stacked vertically, one on top of another",
          side_by_side: "Panels next to each other in columns",
          grid: "Panels in a responsive grid (three or dashboard-style)"
        }
      },
      "panel_count" => {
        type: "choice",
        instructions: "How many panels (visualizations) does `request` ask for?",
        criteria: {
          one: "A single visualization",
          two: "Two visualizations (e.g. a chart plus a table or KPIs)",
          three: "Three visualizations (a small dashboard)"
        }
      },
      "view" => {
        type: "choice",
        instructions: "Which component from the registry best renders `request` (first panel) over this dataset?",
        criteria: view_criteria
      },
      "x_field" => {
        type: "choice",
        instructions: "Which column goes on the category axis, timeline, card title, or scatter x-axis for `request`?",
        criteria: options.merge("none" => "No axis / auto")
      },
      "y_field" => {
        type: "choice",
        instructions: "Which column supplies the numbers for `request`? Judge from the sample values — pick a column whose values are numbers.",
        criteria: options.merge("count_rows" => "Just count rows per category")
      },
      "color_field" => {
        type: "choice",
        instructions: "Which column drives colour/series splits for `request`?",
        criteria: options.merge("none" => "Single colour, no split")
      },
      "size_field" => {
        type: "choice",
        instructions: "Which column drives bubble size (bubbles view) for `request`? Judge from the sample values — pick a column whose values are numbers.",
        criteria: options.merge("none" => "Uniform size")
      },
      "aggregation" => {
        type: "choice",
        instructions: "How should repeated values per category combine for `request` (first panel)?",
        criteria: aggregation_criteria
      },
      "sort_by" => {
        type: "choice",
        instructions: "How should categories/rows be ordered for `request` (first panel)?",
        criteria: sort_criteria
      },
      "show_legend" => noul("Should a legend be shown for `request`?"),
      "show_totals" => noul("Should headline totals/averages be shown for `request`?"),
      "horizontal" => noul("Should bars run horizontally (long category names) for `request`?"),
      "filter_column" => {
        type: "choice",
        instructions: "If `request` keeps only some rows, which column does it filter on?",
        criteria: options.merge("none" => "No filtering — show all rows")
      },
      "filter_op" => {
        type: "choice",
        instructions: "If `request` keeps only some rows, how does the filter value match?",
        criteria: {
          equals: "Keep only rows exactly matching the value",
          contains: "Keep rows whose value contains the text anywhere",
          starts_with: "Keep rows whose value starts with the text",
          ends_with: "Keep rows whose value ends with the text"
        }
      },
      "filter_negate" => noul("Does `request` exclude the matching rows instead of keeping them (e.g. \"not\", \"except\", \"excluding\", \"other than\")?")
    }
    (2..MAX_PANELS).each { |i| questions.merge!(panel_questions(i, options)) }
    questions.merge!(filter_value_questions(columns, rows))
    # Per-column include flags — the width-driven fan-out.
    columns.each_with_index do |col, i|
      questions["include_#{column_ref(i)}"] = noul("Is the column `#{col[:name]}` needed for `request`?")
    end
    questions
  end

  # Jev can't emit free text, so filter values reach it as enumerated
  # choices: one question per low-cardinality column listing its distinct
  # values. Skips long-text columns, near-unique columns (no point filtering
  # to one of 31+ values), and single-value columns. Like the include_ flags,
  # this fan-out scales with data width.
  FILTER_VALUE_MAX_OPTIONS = 30

  def filter_value_questions(columns, rows)
    questions = {}
    columns.each_with_index do |col, i|
      distinct = rows.map { |r| r[col[:name]].nil? ? r[col[:name].to_sym] : r[col[:name]] }
        .compact.map(&:to_s).map(&:strip).reject(&:empty?).uniq
      next if distinct.size < 2 || distinct.size > FILTER_VALUE_MAX_OPTIONS
      next if distinct.any? { |v| v.length > 60 }
      questions["filter_value_#{column_ref(i)}"] = {
        type: "choice",
        instructions: "Which `#{col[:name]}` value does `request` name — either to keep or to exclude? (used only when the filter targets `#{col[:name]}`)",
        criteria: distinct.each_with_object({}) { |v, h| h[v] = "`request` names #{v} (to keep or to exclude)" }
      }
    end
    questions
  end

  def view_criteria
    {
      table: "Sortable data grid, one row per row",
      cards: "Card per row with title and key facts",
      kpi: "Headline totals/averages (counts, sums)",
      bar: "Bar chart: value per category",
      line: "Line chart: trend over time or ordered categories",
      pie: "Pie chart: share of a whole across few categories",
      scatter: "Scatter plot: correlation of two numbers",
      bubbles: "Bubble plot: two numbers plus size and colour"
    }
  end

  def aggregation_criteria
    {
      sum: "Add values up",
      avg: "Average values",
      count: "Count rows"
    }
  end

  def sort_criteria
    {
      value_desc: "Largest value first",
      value_asc: "Smallest value first",
      label_asc: "Alphabetical / chronological"
    }
  end

  def panel_questions(i, options)
    ord = ORDINALS.fetch(i)
    {
      "view_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, which component renders the #{ord} panel?",
        criteria: view_criteria
      },
      "x_field_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, which column goes on the axis/title of the #{ord} panel?",
        criteria: options.merge("none" => "No axis / auto")
      },
      "y_field_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, which column supplies the numbers of the #{ord} panel? Judge from the sample values.",
        criteria: options.merge("count_rows" => "Just count rows per category")
      },
      "color_field_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, which column drives colour splits of the #{ord} panel?",
        criteria: options.merge("none" => "Single colour, no split")
      },
      "aggregation_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, how should values per category combine in the #{ord} panel?",
        criteria: aggregation_criteria
      },
      "sort_by_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, how should the #{ord} panel be ordered?",
        criteria: sort_criteria
      }
    }
  end

  def noul(instructions)
    { type: "noul", instructions: instructions }
  end

  def post_to_jev(payload, api_key, question_count, schema)
    uri = URI(JEV_URL)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 10
    http.read_timeout = 20

    request = Net::HTTP::Post.new(uri.path, {
                                    "Authorization" => "Bearer #{api_key}",
                                    "Content-Type" => "application/json"
                                  })
    request.body = payload.to_json

    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    upstream = http.request(request)
    elapsed_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round

    body = upstream.body.to_s
    parsed = parse_upstream_body(body)
    Rails.logger.warn "Jev API error #{upstream.code}: #{body.truncate(500)}" unless upstream.code.to_i == 200
    if parsed.is_a?(Hash) && upstream.code.to_i == 200
      parsed["question_count"] = question_count
      parsed["upstream_ms"] = elapsed_ms
      parsed["schema"] = schema
    end
    render json: parsed, status: upstream.code.to_i
  rescue Net::OpenTimeout, Net::ReadTimeout => e
    Rails.logger.warn "Jev API timeout: #{e.class}"
    render json: { error: "Jev API timed out, try again." }, status: :bad_gateway
  rescue StandardError => e
    Rails.logger.warn "Jev proxy error: #{e.class}"
    render json: { error: "Could not reach Jev API." }, status: :bad_gateway
  end

  def parse_upstream_body(body)
    JSON.parse(body)
  rescue JSON::ParserError
    { "raw" => body }
  end
end
