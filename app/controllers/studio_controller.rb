require "net/http"
require "uri"
require "json"
require "csv"

# Generalized voice UI studio — the same parallel fan-out pattern as Builder,
# but data-agnostic: the question set is generated from the dataset's own
# schema instead of being hardcoded for tasks/calendar.
#
# State = { request, schema: { columns: [{name, slug, type}] }, rows }.
# Questions = one fixed `view` choice over the component registry + dynamic
# field-binding choices whose options are the dataset's actual columns
# (slugged; Choice supports up to 255 options) + feature nouls + one
# include_<slug> noul per column (the fan-out that scales with data width).
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
    questions = build_questions(schema)
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

  private

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
    parsed = parsed[:csv_rows] if parsed.is_a?(Hash) && parsed[:csv_rows]
    return { error: "Dataset must be an array of objects" } unless parsed.is_a?(Array) && parsed.all? { |r| hash_like?(r) }
    return { error: "Dataset is empty" } if parsed.empty?
    return { error: "Dataset too large (max 500 rows)" } if parsed.size > 500

    { rows: parsed.first(MAX_ROWS * 4).map { |r| r.respond_to?(:to_unsafe_h) ? r.to_unsafe_h : r.to_h } }
  end

  def hash_like?(value)
    value.is_a?(Hash) || value.is_a?(ActionController::Parameters)
  end

  def parse_dataset_json(raw)
    return { error: "No dataset provided (paste JSON or CSV, or pick a sample)" } if raw.blank?
    return parse_dataset_csv(raw) unless raw.lstrip.start_with?("[")

    begin
      JSON.parse(raw)
    rescue JSON::ParserError
      { error: "Dataset is not valid JSON (expected an array of objects)" }
    end
  end

  # CSV alternative to the JSON array: first row is the header. Values stay
  # strings — column_type already recognizes numeric/temporal strings.
  def parse_dataset_csv(raw)
    begin
      table = CSV.parse(raw.strip, headers: true, skip_blanks: true)
    rescue CSV::MalformedCSVError
      return { error: "Dataset is not valid CSV (check quoting)." }
    end
    headers = table.headers.map { |h| h.to_s.strip }
    return { error: "CSV is empty." } if headers.empty?
    return { error: "CSV header row has a blank column name." } if headers.any?(&:empty?)
    return { error: "CSV header row has duplicate column names." } if headers.uniq.size != headers.size
    return { error: "CSV has a header but no data rows." } if table.empty?

    { csv_rows: table.map { |row| row.to_h.transform_keys { |k| k.to_s.strip }.transform_values { |v| v.to_s.strip } } }
  end

  # Column inference shared by question-building and the response meta.
  # Types: numeric | temporal | text | categorical.
  def infer_schema(rows)
    names = rows.each_with_object([]) { |row, acc| row.each_key { |k| acc << k.to_s unless acc.include?(k.to_s) } }
    names = names.first(MAX_COLUMNS)
    slugs = {}
    columns = names.map do |name|
      slug = slugify(name, slugs)
      slugs[slug] = true
      values = rows.map { |r| r[name].nil? ? r[name.to_sym] : r[name] }.compact
      { name: name, slug: slug, type: column_type(values) }
    end
    { columns: columns, row_count: rows.size }
  end

  def slugify(name, taken)
    base = name.to_s.downcase.gsub(/[^a-z0-9]+/, "_").gsub(/^_|_$/, "")
    base = "col" if base.empty?
    slug = base
    i = 2
    while taken[slug]
      slug = "#{base}_#{i}"
      i += 1
    end
    slug
  end

  def column_type(values)
    return "categorical" if values.empty?
    return "numeric" if values.all? { |v| numeric_value?(v) }
    return "temporal" if values.all? { |v| temporal_value?(v) }
    return "text" if values.any? { |v| v.to_s.length > 60 }

    "categorical"
  end

  def numeric_value?(v)
    return true if v.is_a?(Numeric)

    v.is_a?(String) && v.strip.match?(/\A-?\d+(\.\d+)?\z/)
  end

  def temporal_value?(v)
    v.is_a?(String) && v.strip.match?(/\A\d{4}-\d{2}(-\d{2})?\z/)
  end

  def truncate_rows(rows)
    rows.first(10)
  end

  def build_questions(schema)
    columns = schema[:columns]
    by_type = ->(types) { columns.select { |c| types.include?(c[:type]) } }
    option_map = ->(cols) { cols.each_with_object({}) { |c, h| h[c[:slug]] = "`#{c[:name]}` (#{c[:type]})" } }

    numeric = by_type.call(%w[numeric])

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
        criteria: option_map.call(columns).merge("none" => "No axis / auto")
      },
      "y_field" => {
        type: "choice",
        instructions: "Which numeric column supplies the values for `request`?",
        criteria: option_map.call(numeric).merge("count_rows" => "Just count rows per category")
      },
      "color_field" => {
        type: "choice",
        instructions: "Which column drives colour/series splits for `request`?",
        criteria: option_map.call(columns).merge("none" => "Single colour, no split")
      },
      "size_field" => {
        type: "choice",
        instructions: "Which numeric column drives bubble size (bubbles view) for `request`?",
        criteria: option_map.call(numeric).merge("none" => "Uniform size")
      },
      "aggregation" => {
        type: "choice",
        instructions: "How should repeated values per category combine for `request` (first panel)?",
        criteria: aggregation_criteria
      },
      "sort_by" => {
        type: "choice",
        instructions: "How should categories/records be ordered for `request` (first panel)?",
        criteria: sort_criteria
      },
      "show_legend" => noul("Should a legend be shown for `request`?"),
      "show_totals" => noul("Should headline totals/averages be shown for `request`?"),
      "horizontal" => noul("Should bars run horizontally (long category names) for `request`?")
    }
    (2..MAX_PANELS).each { |i| questions.merge!(panel_questions(i, columns, numeric, option_map)) }
    # Per-column include flags — the width-driven fan-out.
    columns.each do |col|
      questions["include_#{col[:slug]}"] = noul("Is the column `#{col[:name]}` (#{col[:type]}) needed for `request`?")
    end
    questions
  end

  def view_criteria
    {
      table: "Sortable data grid, one row per record",
      cards: "Card per record with title and key facts",
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

  def panel_questions(i, columns, numeric, option_map)
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
        criteria: option_map.call(columns).merge("none" => "No axis / auto")
      },
      "y_field_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, which numeric column supplies the values of the #{ord} panel?",
        criteria: option_map.call(numeric).merge("count_rows" => "Just count rows per category")
      },
      "color_field_#{i}" => {
        type: "choice",
        instructions: "If `request` asks for several panels, which column drives colour splits of the #{ord} panel?",
        criteria: option_map.call(columns).merge("none" => "Single colour, no split")
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
