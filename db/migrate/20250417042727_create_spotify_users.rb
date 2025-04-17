class CreateSpotifyUsers < ActiveRecord::Migration[8.0]
  def change
    create_table :spotify_users do |t|
      t.string :uid
      t.string :access_token
      t.string :refresh_token
      t.datetime :token_expiry

      t.timestamps
    end
  end
end
