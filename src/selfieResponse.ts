export async function readSelfieJson<T>(response: Response, action: string): Promise<T> {
  try {
    return await response.json() as T
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const status = `${response.status} ${response.statusText}`.trim()
    throw new Error(`${action}: the server returned an invalid or incomplete response (HTTP ${status}). Please retry and check the server logs if the problem persists.`)
  }
}
