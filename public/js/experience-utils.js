/* Small, dependency-free helpers shared by the clubhouse experience. Keeping
 * these outside the inline app script is the first step toward a maintainable
 * front-end without changing the existing deployment model. */
(function (root) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function retry(fn, options = {}) {
    const attempts = Math.max(1, Number(options.attempts || 3));
    const base = Math.max(50, Number(options.baseDelay || 250));
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try { return await fn(attempt); } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) await sleep(base * (2 ** attempt));
      }
    }
    throw lastError;
  }
  const debounce = (fn, wait = 250) => {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  root.BPTExperience = { sleep, retry, debounce, clamp };
})(window);
