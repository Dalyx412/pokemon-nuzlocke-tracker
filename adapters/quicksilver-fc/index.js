const { createFireRedAdapter } = require('../radical-red');

// 宝可梦水银FC (~致150年后的你) is a CFRU-based FireRed hack, so the Radical Red adapter's
// logic and Lua exporter apply unchanged; only the data differs. data/ is generated from
// the ROM by build-data.js.
module.exports = createFireRedAdapter({ id: 'quicksilver-fc', rootDir: __dirname });
