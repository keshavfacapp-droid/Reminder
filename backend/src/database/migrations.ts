import type { Knex } from 'knex';

interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

// Schema is written with the Knex schema builder so the same migrations run
// unchanged on SQLite and PostgreSQL. All timestamps are epoch milliseconds.
const migrations: Migration[] = [
  {
    name: '001_initial',
    async up(knex) {
      await knex.schema.createTable('users', (t) => {
        t.increments('id').primary();
        t.string('username', 64).notNullable().unique();
        t.string('password_hash', 255).notNullable();
        t.bigInteger('created_at').notNullable();
        t.bigInteger('last_seen').nullable();
      });

      await knex.schema.createTable('sessions', (t) => {
        // SHA-256 of the session token; the raw token only lives in the cookie.
        t.string('id', 64).primary();
        t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        t.string('csrf_token', 64).notNullable();
        t.bigInteger('created_at').notNullable();
        t.bigInteger('expires_at').notNullable();
        t.bigInteger('absolute_expires_at').notNullable();
        t.index(['user_id']);
      });

      await knex.schema.createTable('messages', (t) => {
        t.increments('id').primary();
        t.integer('sender_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        t.string('message_type', 16).notNullable(); // text | link | photo | video | document
        t.text('text_content').nullable();
        t.string('file_path', 255).nullable(); // relative to STORAGE_DIR
        t.string('display_path', 255).nullable(); // compressed photo variant
        t.string('thumb_path', 255).nullable();
        t.string('file_name', 255).nullable();
        t.string('mime_type', 128).nullable();
        t.bigInteger('file_size').nullable();
        t.text('link_url').nullable();
        t.string('link_title', 300).nullable();
        t.string('link_site', 200).nullable();
        t.bigInteger('created_at').notNullable();
        t.bigInteger('read_at').nullable();
        t.bigInteger('deleted_at').nullable();
        t.index(['message_type', 'id']);
        t.index(['sender_id', 'read_at']);
      });

      await knex.schema.createTable('push_subscriptions', (t) => {
        t.increments('id').primary();
        t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        t.text('endpoint').notNullable();
        t.string('endpoint_hash', 64).notNullable().unique();
        t.string('public_key', 255).notNullable();
        t.string('auth_key', 255).notNullable();
        t.bigInteger('created_at').notNullable();
        t.index(['user_id']);
      });
    },
    async down(knex) {
      await knex.schema.dropTableIfExists('push_subscriptions');
      await knex.schema.dropTableIfExists('messages');
      await knex.schema.dropTableIfExists('sessions');
      await knex.schema.dropTableIfExists('users');
    },
  },
];

export const migrationSource: Knex.MigrationSource<Migration> = {
  getMigrations: async () => migrations,
  getMigrationName: (m) => m.name,
  getMigration: async (m) => m,
};
