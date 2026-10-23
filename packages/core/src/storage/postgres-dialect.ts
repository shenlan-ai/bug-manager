import { PostgresDialect, sql } from "kysely";
import type { Kysely, DatabaseMetadataOptions, TableMetadata } from "kysely";
import type { Schema } from "./schema.js";

// The default introspector inspects every accessible schema and calls a serial
// lookup for every column. Unrelated concurrent DDL can race those lookups and
// same-name tables outside the configured search_path must never prove existence.
export class ScopedPostgresDialect extends PostgresDialect {
  override createIntrospector(db: Kysely<Schema>) {
    const getTables = async (
      options?: DatabaseMetadataOptions,
    ): Promise<TableMetadata[]> => {
      const rows = (
        await sql<{
          schema: string;
          table_name: string;
          relation_kind: string;
          column_name: string;
          data_type: string;
          nullable: boolean;
          has_default: boolean;
        }>`
        SELECT n.nspname AS schema, c.relname AS table_name, c.relkind AS relation_kind,
          a.attname AS column_name, t.typname AS data_type,
          NOT a.attnotnull AS nullable, a.atthasdef AS has_default
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
        JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
        WHERE n.nspname=current_schema() AND c.relkind IN ('r','v','m','p')
          AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname,a.attnum`.execute(db)
      ).rows;
      const tables = new Map<string, TableMetadata>();
      for (const row of rows) {
        if (
          !options?.withInternalKyselyTables &&
          ["kysely_migration", "kysely_migration_lock"].includes(row.table_name)
        )
          continue;
        let table = tables.get(row.table_name);
        if (!table) {
          table = {
            name: row.table_name,
            schema: row.schema,
            isView: ["v", "m"].includes(row.relation_kind),
            columns: [],
          };
          tables.set(row.table_name, table);
        }
        table.columns.push({
          name: row.column_name,
          dataType: row.data_type,
          isAutoIncrementing: false,
          isNullable: row.nullable,
          hasDefaultValue: row.has_default,
        });
      }
      return [...tables.values()];
    };
    return {
      getTables,
      getSchemas: async () =>
        (
          await sql<{ name: string }>`SELECT current_schema() AS name`.execute(
            db,
          )
        ).rows,
      getMetadata: async (options?: DatabaseMetadataOptions) => ({
        tables: await getTables(options),
      }),
    };
  }
}
