const fs = require('fs');
const path = require('path');

const NATURE_NAMES_ZH = [
  '\u52e4\u594b', '\u6015\u5bc2\u5bde', '\u52c7\u6562', '\u56fa\u6267', '\u987d\u76ae',
  '\u5927\u80c6', '\u5766\u7387', '\u60a0\u95f2', '\u6dd8\u6c14', '\u4e50\u5929',
  '\u80c6\u5c0f', '\u6025\u8e81', '\u8ba4\u771f', '\u723d\u6717', '\u5929\u771f',
  '\u5185\u655b', '\u6162\u541e\u541e', '\u51b7\u9759', '\u5bb3\u7f9e', '\u9a6c\u864e',
  '\u6e29\u548c', '\u6e29\u987a', '\u81ea\u5927', '\u614e\u91cd', '\u6d6e\u8e81',
];

const NATURE_STATS = ['attack', 'defense', 'speed', 'spAttack', 'spDefense'];

// Shared by every CFRU / FireRed-based adapter: they differ only in id and in the data
// directory (data/data.js + data/mapsec_table.json) they read.
function createFireRedAdapter({ id, rootDir }) {
  const ADAPTER_ID = id;
  const ROOT_DIR = rootDir;
  const DATA_JS_PATH = path.join(ROOT_DIR, 'data', 'data.js');

  function loadJson(relativePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[adapter:${ADAPTER_ID}] failed to load ${relativePath}: ${error.message}`);
      }
      return fallback;
    }
  }

  function loadData() {
    const source = fs.readFileSync(DATA_JS_PATH, 'utf8');
    return Function(`"use strict"; return (${source});`)();
  }

  function getSprite(speciesId) {
    const sprite = DATA.sprites?.[String(speciesId)];
    return typeof sprite === 'string' && sprite.startsWith('data:image/png;base64,') ? sprite : null;
  }

  // split is the ROM's name for what the games now call the damage category.
  const MOVE_CATEGORY_BY_SPLIT = ['physical', 'special', 'status'];

  function typeName(typeId) {
    return DATA.types?.[String(typeId)]?.name ?? null;
  }

  // Resolve a move to the ROM's actual data. Radical Red adds custom moves (e.g. Aqua
  // Fang) and tweaks the power/accuracy of existing ones, so these fields are the source
  // of truth — the server only layers Chinese name/description on top and fills any gaps.
  function moveEntry(moveId) {
    const move = DATA.moves?.[String(moveId)];
    if (!move || !move.name) return null;
    return {
      id: Number(moveId),
      name: move.name,
      type: typeName(move.type),
      category: MOVE_CATEGORY_BY_SPLIT[move.split] ?? null,
      power: Number.isFinite(move.power) ? move.power : null,
      accuracy: Number.isFinite(move.accuracy) ? move.accuracy : null,
      pp: Number.isFinite(move.pp) ? move.pp : null,
      description: move.description ?? null,
    };
  }

  // The TM/HM list holds the TMs first, then the HMs (120 + 8 in both CFRU hacks here).
  const TM_COUNT = 120;
  const tmLabel = (index) => (index < TM_COUNT
    ? `TM${String(index + 1).padStart(2, '0')}`
    : `HM${String(index - TM_COUNT + 1).padStart(2, '0')}`);

  // Evolution methods 1-249 are real evolutions; 253/254 are Gigantamax/Mega form links.
  const isRealEvolution = (method) => method >= 1 && method < 250;
  let preEvolutionsOf = null;
  function preEvolutions(speciesId) {
    if (!preEvolutionsOf) {
      preEvolutionsOf = new Map();
      for (const species of Object.values(DATA.species || {})) {
        for (const [method, , target] of Array.isArray(species.evolutions) ? species.evolutions : []) {
          if (!isRealEvolution(method) || !DATA.species[String(target)] || target === species.ID) continue;
          if (!preEvolutionsOf.has(target)) preEvolutionsOf.set(target, []);
          preEvolutionsOf.get(target).push(species.ID);
        }
      }
    }
    // Every earlier stage, nearest first (a species can have more than one, e.g. babies).
    const ancestors = [];
    const seen = new Set([Number(speciesId)]);
    const queue = [Number(speciesId)];
    while (queue.length) {
      for (const parent of preEvolutionsOf.get(queue.shift()) || []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        ancestors.push(parent);
        queue.push(parent);
      }
    }
    return ancestors;
  }

  const levelUpEntries = (species) => (Array.isArray(species?.levelupMoves) ? species.levelupMoves : [])
    .map((entry) => (Array.isArray(entry) ? entry : [entry, 0]))
    .map(([id, level]) => [Number(id), Number(level) || 0]);

  // Every move a species can legally learn regardless of game progress, from its own
  // level-up / TM / tutor / egg tables plus its earlier stages' level-up moves. Each move
  // appears once per section and carries ALL of its sources, so the UI can label them.
  function getLearnableMoves(speciesId) {
    const species = DATA.species?.[String(speciesId)];
    if (!species) return null;

    const sourcesByMove = new Map();
    const addSource = (moveId, source) => {
      if (!moveId || !DATA.moves?.[String(moveId)]) return false;
      if (!sourcesByMove.has(moveId)) sourcesByMove.set(moveId, []);
      const list = sourcesByMove.get(moveId);
      // One source per kind (and per earlier stage); level-up keeps the lowest level.
      const same = list.find((s) => s.kind === source.kind && s.speciesId === source.speciesId);
      if (same) return false;
      list.push(source);
      return true;
    };

    const levelUpIds = [];
    for (const [id, level] of levelUpEntries(species)) {
      if (addSource(id, { kind: 'levelup', level })) levelUpIds.push(id);
    }

    const tmIds = [];
    (Array.isArray(species.tmMoves) ? species.tmMoves : []).forEach((index) => {
      const id = DATA.tmMoves?.[String(index)];
      if (addSource(id, { kind: 'tm', label: tmLabel(index) })) tmIds.push(id);
    });

    const tutorIds = [];
    for (const index of Array.isArray(species.tutorMoves) ? species.tutorMoves : []) {
      const id = DATA.tutorMoves?.[String(index)];
      if (addSource(id, { kind: 'tutor' })) tutorIds.push(id);
    }

    // Egg moves are listed on the base stage, so pull them from the whole line.
    const ancestors = preEvolutions(speciesId);
    const eggIds = [];
    for (const holderId of [Number(speciesId), ...ancestors]) {
      for (const id of DATA.species[String(holderId)]?.eggMoves || []) {
        if (addSource(id, { kind: 'egg' })) eggIds.push(id);
      }
    }

    const preEvolutionIds = [];
    for (const ancestorId of ancestors) {
      const ancestor = DATA.species[String(ancestorId)];
      for (const [id, level] of levelUpEntries(ancestor)) {
        const source = { kind: 'prevo', speciesId: ancestorId, speciesName: ancestor.name, level };
        if (addSource(id, source) && !preEvolutionIds.includes(id)) preEvolutionIds.push(id);
      }
    }

    const ownLevelUp = new Set(levelUpIds);
    const entry = (id, extra = {}) => ({ ...moveEntry(id), ...extra, sources: sourcesByMove.get(id) });
    const sourceOf = (id, kind) => sourcesByMove.get(id).find((s) => s.kind === kind);
    return {
      levelUpMoves: levelUpIds.map((id) => entry(id, { level: sourceOf(id, 'levelup').level })),
      tmMoves: tmIds.map((id) => entry(id, { label: sourceOf(id, 'tm').label })),
      tutorMoves: tutorIds.map((id) => entry(id)),
      eggMoves: eggIds.map((id) => entry(id)),
      // Only what the current stage can't already pick up by levelling.
      preEvolutionMoves: preEvolutionIds.filter((id) => !ownLevelUp.has(id)).map((id) => {
        const source = sourceOf(id, 'prevo');
        return entry(id, { level: source.level, fromSpeciesId: source.speciesId, fromSpeciesName: source.speciesName });
      }),
    };
  }

  function resolveLocationName(mon) {
    const mapsecId = mon.metMapsec ?? mon.metLocation ?? null;
    return mapsecId != null ? (MAPSEC_NAMES[String(mapsecId)] ?? null) : null;
  }

  function resolveNature(mon) {
    const natureId = Number.isInteger(mon.natureId)
      ? mon.natureId
      : Number.isInteger(mon.personality)
        ? mon.personality % 25
        : null;
    if (natureId == null || natureId < 0 || natureId > 24) {
      return { natureId: null, natureName: null, natureNameZh: null, natureUp: null, natureDown: null };
    }
    const up = NATURE_STATS[Math.floor(natureId / 5)] ?? null;
    const down = NATURE_STATS[natureId % 5] ?? null;
    return {
      natureId,
      natureName: DATA.natures?.[String(natureId)] ?? null,
      natureNameZh: NATURE_NAMES_ZH[natureId] ?? null,
      natureUp: up !== down ? up : null,
      natureDown: up !== down ? down : null,
    };
  }

  function estimatePp(mon) {
    if (!mon.ppEstimated || !Array.isArray(mon.moves)) return mon.pp;
    return mon.moves.map((id, index) => {
      const current = Array.isArray(mon.pp) ? mon.pp[index] : null;
      return current || DATA.moves?.[String(id)]?.pp || 0;
    });
  }

  function processPayload(rawPayload) {
    if (!rawPayload || !Array.isArray(rawPayload.party)) return rawPayload;
    const enrichMon = (mon) => {
      const locationNameZh = resolveLocationName(mon);
      const nature = resolveNature(mon);
      return {
        ...mon,
        pp: estimatePp(mon),
        metLocationNameZh: locationNameZh,
        metMapsecNameZh: locationNameZh,
        natureId: nature.natureId,
        natureName: nature.natureName,
        natureNameZh: nature.natureNameZh,
        natureUp: nature.natureUp,
        natureDown: nature.natureDown,
      };
    };

    return {
      adapterId: ADAPTER_ID,
      gameCode: rawPayload.gameCode ?? null,
      frame: rawPayload.frame ?? null,
      party: rawPayload.party.map(enrichMon),
      pc: rawPayload.pc
        ? {
            ...rawPayload.pc,
            boxes: Array.isArray(rawPayload.pc.boxes)
              ? rawPayload.pc.boxes.map((box) => ({
                  ...box,
                  pokemon: Array.isArray(box.pokemon) ? box.pokemon.map(enrichMon) : [],
                }))
              : [],
          }
        : null,
    };
  }

  const MAPSEC_NAMES = loadJson('data/mapsec_table.json', {});
  const DATA = loadData();

  return {
    id: ADAPTER_ID,
    dataJsPath: DATA_JS_PATH,
    loadData,
    getSprite,
    getLearnableMoves,
    processPayload,
  };
}

module.exports = createFireRedAdapter({ id: 'radical-red', rootDir: __dirname });
module.exports.createFireRedAdapter = createFireRedAdapter;

if (require.main === module) {
  console.log('[adapter:radical-red] This adapter is loaded by server/index.js now.');
  console.log('[adapter:radical-red] Start the server process instead: node server/index.js');
}
