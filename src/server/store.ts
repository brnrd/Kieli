import { HttpError } from "./errors";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config, required } from "./config";

export type RecordValue = { version: number; [key: string]: unknown };
export type Change = {
  pk: string;
  sk: string;
  value?: RecordValue;
  expectedVersion?: number;
  check?: boolean;
};
export type PageOptions = {
  limit: number;
  cursor?: string;
  query?: string;
  namespace?: string;
  status?: string;
  languages?: string[];
  reverse?: boolean;
};
export interface Store {
  get<T>(pk: string, sk: string): Promise<T | undefined>;
  list<T>(pk: string, prefix: string): Promise<T[]>;
  put(
    pk: string,
    sk: string,
    value: RecordValue,
    expectedVersion?: number,
  ): Promise<void>;
  remove(pk: string, sk: string, expectedVersion: number): Promise<void>;
  transact(changes: Change[]): Promise<void>;
  page<T>(
    pk: string,
    prefix: string,
    options: PageOptions,
  ): Promise<{ items: T[]; nextCursor?: string }>;
}
function validateTransaction(changes: Change[]) {
  if (
    changes.length > 100 ||
    Buffer.byteLength(JSON.stringify(changes)) > 3.5 * 1024 * 1024
  )
    throw new HttpError(
      413,
      "Write batch exceeds the transaction size limit. Retry with fewer keys.",
    );
}
export class Conflict extends Error {
  constructor() {
    super("This record changed. Refresh and try again.");
  }
}
export class InvalidCursor extends Error {
  constructor() {
    super("Invalid pagination cursor.");
  }
}
function decodeCursor(
  cursor: string | undefined,
  pk: string,
): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      parsed.pk !== pk ||
      typeof parsed.sk !== "string" ||
      cursor.length > 1024
    )
      throw new Error();
    return parsed.sk;
  } catch {
    throw new InvalidCursor();
  }
}
const encodeCursor = (pk: string, sk: string) =>
  Buffer.from(JSON.stringify({ pk, sk })).toString("base64url");

export async function sqliteStore(path: string): Promise<Store> {
  const { DatabaseSync } = await import("node:sqlite");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (pk TEXT NOT NULL, sk TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(pk, sk));",
  );
  db.prepare(
    "DELETE FROM records WHERE json_extract(data, '$.ttl') IS NOT NULL AND json_extract(data, '$.ttl') <= ?",
  ).run(Math.floor(Date.now() / 1000));
  const put = (
    pk: string,
    sk: string,
    value: RecordValue,
    expectedVersion?: number,
  ) => {
    const result =
      expectedVersion === undefined
        ? db
            .prepare(
              "INSERT OR IGNORE INTO records (pk, sk, version, data) VALUES (?, ?, ?, ?)",
            )
            .run(pk, sk, value.version, JSON.stringify(value))
        : db
            .prepare(
              "UPDATE records SET version = ?, data = ? WHERE pk = ? AND sk = ? AND version = ?",
            )
            .run(value.version, JSON.stringify(value), pk, sk, expectedVersion);
    if (!result.changes) throw new Conflict();
  };
  const remove = (pk: string, sk: string, expectedVersion: number) => {
    const result = db
      .prepare("DELETE FROM records WHERE pk = ? AND sk = ? AND version = ?")
      .run(pk, sk, expectedVersion);
    if (!result.changes) throw new Conflict();
  };
  return {
    async get<T>(pk: string, sk: string) {
      const row = db
        .prepare("SELECT data FROM records WHERE pk = ? AND sk = ?")
        .get(pk, sk);
      return row ? (JSON.parse(row.data as string) as T) : undefined;
    },
    async list<T>(pk: string, prefix: string) {
      return db
        .prepare(
          "SELECT data FROM records WHERE pk = ? AND sk >= ? AND sk < ? ORDER BY sk",
        )
        .all(pk, prefix, prefix + "\uffff")
        .map((row) => JSON.parse(row.data as string) as T);
    },
    async put(pk, sk, value, expectedVersion) {
      put(pk, sk, value, expectedVersion);
    },
    async remove(pk, sk, expectedVersion) {
      remove(pk, sk, expectedVersion);
    },
    async transact(changes) {
      validateTransaction(changes);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const change of changes) {
          if (change.check) {
            const current = db
              .prepare("SELECT version FROM records WHERE pk = ? AND sk = ?")
              .get(change.pk, change.sk);
            if (!current || current.version !== change.expectedVersion)
              throw new Conflict();
          } else if (change.value)
            put(change.pk, change.sk, change.value, change.expectedVersion);
          else remove(change.pk, change.sk, change.expectedVersion!);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async page<T>(pk: string, prefix: string, options: PageOptions) {
      const after = decodeCursor(options.cursor, pk);
      const clauses = ["pk = ?", "sk >= ?", "sk < ?"];
      const args: (string | number)[] = [pk, prefix, prefix + "\uffff"];
      if (after) {
        clauses.push(options.reverse ? "sk < ?" : "sk > ?");
        args.push(after);
      }
      if (options.query) {
        clauses.push("instr(json_extract(data, '$.searchText'), ?) > 0");
        args.push(options.query.toLowerCase());
      }
      if (options.namespace) {
        clauses.push("json_extract(data, '$.namespace') = ?");
        args.push(options.namespace);
      }
      if (options.status && options.languages?.length) {
        const field =
          options.status === "outdated"
            ? "outdatedLanguages"
            : options.status === "missing"
              ? "populatedLanguages"
              : "filledLanguages";
        const expression =
          field === "populatedLanguages"
            ? "COALESCE(json_extract(records.data, '$.populatedLanguages'), json_extract(records.data, '$.filledLanguages'))"
            : `json_extract(records.data, '$.${field}')`;
        const tests = options.languages.map((code) => {
          args.push(code);
          return `EXISTS (SELECT 1 FROM json_each(${expression}) WHERE value = ?)`;
        });
        clauses.push(
          `${["missing", "incomplete"].includes(options.status) ? "NOT " : ""}(${tests.join(options.status === "outdated" ? " OR " : " AND ")})`,
        );
      }
      args.push(options.limit + 1);
      const rows = db
        .prepare(
          `SELECT sk, data FROM records WHERE ${clauses.join(" AND ")} ORDER BY sk ${options.reverse ? "DESC" : "ASC"} LIMIT ?`,
        )
        .all(...args);
      const items = rows
        .slice(0, options.limit)
        .map((row) => JSON.parse(row.data as string) as T);
      return {
        items,
        nextCursor:
          rows.length > options.limit
            ? encodeCursor(pk, rows[options.limit - 1]!.sk as string)
            : undefined,
      };
    },
  };
}

async function dynamoStore(): Promise<Store> {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const {
    DynamoDBDocumentClient,
    GetCommand,
    QueryCommand,
    PutCommand,
    DeleteCommand,
    TransactWriteCommand,
  } = await import("@aws-sdk/lib-dynamodb");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const TableName = required("DYNAMODB_TABLE");
  const condition = (expectedVersion?: number) =>
    expectedVersion === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : {
          ConditionExpression: "#v = :version",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":version": expectedVersion },
        };
  const guarded = async (call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "ConditionalCheckFailedException" ||
          (error.name === "TransactionCanceledException" &&
            "CancellationReasons" in error &&
            Array.isArray(error.CancellationReasons) &&
            (error.CancellationReasons as { Code: string }[]).some(
              (r) =>
                r.Code === "ConditionalCheckFailed" ||
                r.Code === "TransactionConflict",
            )))
      )
        throw new Conflict();
      throw error;
    }
  };
  return {
    async get<T>(pk: string, sk: string) {
      const result = await client.send(
        new GetCommand({ TableName, Key: { pk, sk }, ConsistentRead: true }),
      );
      return result.Item?.data as T | undefined;
    },
    async list<T>(pk: string, prefix: string) {
      const records: T[] = [];
      let cursor: import("@aws-sdk/lib-dynamodb").QueryCommandInput["ExclusiveStartKey"];
      do {
        const result: import("@aws-sdk/lib-dynamodb").QueryCommandOutput =
          await client.send(
            new QueryCommand({
              TableName,
              KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
              ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
              ConsistentRead: true,
              ExclusiveStartKey: cursor,
            }),
          );
        records.push(...(result.Items ?? []).map((item) => item.data as T));
        cursor = result.LastEvaluatedKey;
      } while (cursor);
      return records;
    },
    async put(pk, sk, value, expectedVersion) {
      await guarded(() =>
        client.send(
          new PutCommand({
            TableName,
            Item: {
              pk,
              sk,
              version: value.version,
              data: value,
              ...(typeof value.ttl === "number" ? { ttl: value.ttl } : {}),
            },
            ...condition(expectedVersion),
          }),
        ),
      );
    },
    async remove(pk, sk, expectedVersion) {
      await guarded(() =>
        client.send(
          new DeleteCommand({
            TableName,
            Key: { pk, sk },
            ...condition(expectedVersion),
          }),
        ),
      );
    },
    async transact(changes) {
      validateTransaction(changes);
      await guarded(() =>
        client.send(
          new TransactWriteCommand({
            TransactItems: changes.map((c) =>
              c.check
                ? {
                    ConditionCheck: {
                      TableName,
                      Key: { pk: c.pk, sk: c.sk },
                      ...condition(c.expectedVersion),
                    },
                  }
                : c.value
                  ? {
                      Put: {
                        TableName,
                        Item: {
                          pk: c.pk,
                          sk: c.sk,
                          version: c.value.version,
                          data: c.value,
                          ...(typeof c.value.ttl === "number"
                            ? { ttl: c.value.ttl }
                            : {}),
                        },
                        ...condition(c.expectedVersion),
                      },
                    }
                  : {
                      Delete: {
                        TableName,
                        Key: { pk: c.pk, sk: c.sk },
                        ...condition(c.expectedVersion),
                      },
                    },
            ),
          }),
        ),
      );
    },
    async page<T>(pk: string, prefix: string, options: PageOptions) {
      const after = decodeCursor(options.cursor, pk);
      let cursor: import("@aws-sdk/lib-dynamodb").QueryCommandInput["ExclusiveStartKey"] =
        after ? { pk, sk: after } : undefined;
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = { ":pk": pk, ":prefix": prefix };
      const filters: string[] = [];
      if (options.query) {
        names["#search"] = "searchText";
        values[":q"] = options.query.toLowerCase();
        filters.push("contains(#data.#search, :q)");
      }
      if (options.namespace) {
        names["#namespace"] = "namespace";
        values[":namespace"] = options.namespace;
        filters.push("#data.#namespace = :namespace");
      }
      if (options.status && options.languages?.length) {
        const field =
          options.status === "outdated"
            ? "outdatedLanguages"
            : options.status === "missing"
              ? "populatedLanguages"
              : "filledLanguages";
        names["#state"] = field;
        if (options.status === "missing") names["#filled"] = "filledLanguages";
        const tests = options.languages.map((code, i) => {
          values[`:l${i}`] = code;
          return options.status === "missing"
            ? `(contains(#data.#state, :l${i}) OR (attribute_not_exists(#data.#state) AND contains(#data.#filled, :l${i})))`
            : `contains(#data.#state, :l${i})`;
        });
        filters.push(
          `${["missing", "incomplete"].includes(options.status) ? "NOT " : ""}(${tests.join(options.status === "outdated" ? " OR " : " AND ")})`,
        );
      }
      if (filters.length) names["#data"] = "data";
      const items: T[] = [];
      do {
        const result: import("@aws-sdk/lib-dynamodb").QueryCommandOutput =
          await client.send(
            new QueryCommand({
              TableName,
              KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
              ExpressionAttributeValues: values,
              ...(filters.length
                ? {
                    FilterExpression: filters.join(" AND "),
                    ExpressionAttributeNames: names,
                  }
                : {}),
              ConsistentRead: true,
              ExclusiveStartKey: cursor,
              ScanIndexForward: !options.reverse,
              Limit: options.limit - items.length,
            }),
          );
        items.push(...(result.Items ?? []).map((item) => item.data as T));
        cursor = result.LastEvaluatedKey;
      } while (cursor && items.length < options.limit);
      return {
        items,
        nextCursor: cursor ? encodeCursor(pk, cursor.sk as string) : undefined,
      };
    },
  };
}
let singleton: Promise<Store> | undefined;
export function getStore() {
  return (singleton ??=
    config().driver === "dynamodb"
      ? dynamoStore()
      : sqliteStore(process.env.SQLITE_PATH ?? ".data/kieli.sqlite"));
}
