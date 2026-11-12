import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";

export const sessionSecurity: Record<string, string[]>[] = [
  { sessionCookie: [] },
  { bearerAuth: [] },
];
export const optionalSessionSecurity: Record<string, string[]>[] = [{}, ...sessionSecurity];

export const apiErrorSchema = z
  .object({
    code: z.string().describe("Machine-readable reason. Use this to choose recovery behavior."),
    message: z.string().describe("Human-readable explanation; do not parse it for control flow."),
    requestId: z.string().optional().describe("Include this identifier when reporting a failure."),
    details: z.unknown().optional().describe("Additional context specific to the error code."),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string().optional(),
        details: z.unknown().optional(),
      })
      .optional(),
  })
  .meta({ ref: "ApiError" });

export function jsonResponse(schema: z.ZodType, description = "Successful response") {
  return { description, content: { "application/json": { schema: resolver(schema) } } };
}

export function jsonBody(schema: z.ZodType, required = true) {
  return { required, content: { "application/json": { schema: resolver(schema) } } };
}

// Documentation references the handler's schemas without introducing a second parser.
// Some handlers normalize legacy inputs or authenticate before reading the body.
export function queryParameters(schema: z.ZodObject) {
  return Object.entries(schema.shape).map(([name, field]) => ({
    name,
    in: "query" as const,
    required: !field.safeParse(undefined).success,
    // Queries arrive as strings, but numeric query values should generate numeric
    // client arguments. Output conversion preserves coerce.number() constraints.
    schema: z.toJSONSchema(field, { io: "output" }),
    // OpenAPI 3.1 accepts Zod's JSON Schema 2020-12 output; openapi-types
    // models the type union more narrowly than the converter's return type.
  })) as NonNullable<Parameters<typeof describeRoute>[0]["parameters"]>;
}

type Description = Parameters<typeof describeRoute>[0];

export function operation(
  operationId: string,
  tag: string,
  summary: string,
  options: Description & {
    response?: z.ZodType;
    query?: z.ZodObject;
    body?: z.ZodType;
    errors?: readonly number[];
  } = {},
) {
  const { response, query, body, errors = [], ...description } = options;
  const hasSession =
    description.security?.length &&
    description.security.every((scheme) => Object.keys(scheme).length > 0);
  const statuses = new Set([
    ...(hasSession ? [401, 403] : []),
    ...(body || query || description.requestBody ? [422] : []),
    ...errors,
  ]);
  return describeRoute({
    operationId,
    tags: [tag],
    summary,
    security: [],
    ...(query ? { parameters: queryParameters(query) } : {}),
    ...(body ? { requestBody: jsonBody(body) } : {}),
    ...description,
    responses: {
      ...(response ? { 200: jsonResponse(response) } : {}),
      ...Object.fromEntries(
        [...statuses].map((status) => [
          status,
          jsonResponse(
            apiErrorSchema,
            {
              400: "Provider input validation failed",
              401: "Session or credentials missing, invalid, or expired",
              403: "Role, ownership, origin, or account permission denied",
              404: "Resource not found",
              409: "Revision, status, account, or retention conflict",
              415: "Unsupported request media type",
              422: "Invalid request input",
              429: "Rate limit exceeded; respect Retry-After",
              503: "Feature locked or dependency temporarily unavailable",
            }[status] ?? "Request failed",
          ),
        ]),
      ),
      default: jsonResponse(
        apiErrorSchema,
        "Request rejected or dependency failure. Read code and message; forwarded errors may omit the nested error envelope.",
      ),
      ...description.responses,
    },
  });
}
