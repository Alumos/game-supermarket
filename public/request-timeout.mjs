// Chromium 99 supports AbortController, but not AbortSignal.timeout().
// Keep the deadline active through response parsing and always release the timer.
export async function withRequestTimeout(request, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
