try {
  process.setMaxListeners(Math.max(process.getMaxListeners(), 64));
} catch {}
