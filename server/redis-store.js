// Saved data in Redis (the cloud version): race results and the practice log, as lists of JSON.
const K = (prefix) => ({ results: `${prefix}results`, practice: `${prefix}practice` });
const parseAll = (rows) => rows.map((r) => JSON.parse(r));

export async function redisStore(redis, { prefix = 'hr:', history = false, log = console.log } = {}) {
  const k = K(prefix);
  const warn = (e) => log(`⚠️  Redis write failed: ${e.message}`);
  const store = {
    results: [],
    practice: [],
    // The game keeps the history in memory and appends to Redis as it goes.
    addResult(e) {
      store.results.push(e);
      redis.rpush(k.results, JSON.stringify(e)).catch(warn);
    },
    addPractice(e) {
      store.practice.push(e);
      redis.rpush(k.practice, JSON.stringify(e)).catch(warn);
    },
    allPractice: async () => parseAll(await redis.lrange(k.practice, 0, -1)),
    reset() {
      store.results.length = 0;
      store.practice.length = 0;
      redis.del(k.results, k.practice).catch(warn);
    },
  };
  if (history) {
    const [r, p] = await Promise.all([redis.lrange(k.results, 0, -1), redis.lrange(k.practice, 0, -1)]);
    store.results.push(...parseAll(r));
    store.practice.push(...parseAll(p));
  }
  return store;
}
