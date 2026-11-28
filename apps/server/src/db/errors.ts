/** PostgreSQL の一意制約違反(23505)か。Drizzle はドライバのエラーを cause に包む */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === '23505';
}
