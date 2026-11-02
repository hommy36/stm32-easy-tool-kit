// Use only with the isolated profile described in docs/verification.md.
exports.activate=async()=>{
  try { await require('../clion-host-smoke.cjs').run(); }
  catch(error) {
    await require('node:fs/promises').writeFile(require('node:path').resolve(__dirname,'../../.cache/clion-host-error.log'),String(error.stack));
  }
};
