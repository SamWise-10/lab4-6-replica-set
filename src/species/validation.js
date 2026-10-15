// Input validation for the `species` collection (application layer).
//
// Every validator collects ALL problems instead of stopping at the first one,
// and returns a normalized copy of the input:
//   { ok: true,  value }            on success
//   { ok: false, errors: [string] } on failure
import { ObjectId } from "mongodb";

export const KINGDOMS = ["Animalia", "Plantae", "Fungi", "Protista", "Chromista", "Bacteria", "Archaea"];

// IUCN Red List categories
export const STATUSES = {
  LC: "Least Concern",
  NT: "Near Threatened",
  VU: "Vulnerable",
  EN: "Endangered",
  CR: "Critically Endangered",
  EW: "Extinct in the Wild",
  EX: "Extinct",
  DD: "Data Deficient",
  NE: "Not Evaluated",
};

// "Genus species" or "Genus species subspecies" (binomial / trinomial nomenclature)
export const SCIENTIFIC_NAME_RE = /^[A-Z][a-z]+ [a-z]+(?: [a-z]+)?$/;

export const LIMITS = {
  commonName: { min: 2, max: 100 },
  habitat: { min: 2, max: 50 },
  habitatsMax: 20,
  populationMax: 1e12,
};

const ALLOWED_FIELDS = ["commonName", "scientificName", "kingdom", "conservationStatus", "population", "habitats"];
const REQUIRED_FIELDS = ["commonName", "scientificName", "kingdom", "conservationStatus"];
const IMMUTABLE_FIELDS = ["_id", "createdAt", "updatedAt"];

const show = (v) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

// ---------- per-field validators: return [normalizedValue, error|null] ----------

function vCommonName(v) {
  if (typeof v !== "string") return [v, `commonName: must be a string (got ${show(v)})`];
  const s = v.trim().replace(/\s+/g, " ");
  const { min, max } = LIMITS.commonName;
  if (s.length < min || s.length > max)
    return [s, `commonName: must be ${min}-${max} characters (got ${s.length})`];
  if (!/^[\p{L}\p{M}' .-]+$/u.test(s))
    return [s, `commonName: may only contain letters, spaces, apostrophes, hyphens and periods (got ${show(s)})`];
  return [s, null];
}

function vScientificName(v) {
  if (typeof v !== "string") return [v, `scientificName: must be a string (got ${show(v)})`];
  const s = v.trim().replace(/\s+/g, " ");
  if (!SCIENTIFIC_NAME_RE.test(s))
    return [s, `scientificName: must look like "Genus species" - capitalized genus, lowercase epithet (got ${show(s)})`];
  return [s, null];
}

function vKingdom(v) {
  if (typeof v !== "string") return [v, `kingdom: must be a string (got ${show(v)})`];
  const match = KINGDOMS.find((k) => k.toLowerCase() === v.trim().toLowerCase());
  if (!match) return [v, `kingdom: must be one of ${KINGDOMS.join(", ")} (got ${show(v)})`];
  return [match, null];
}

function vStatus(v) {
  if (typeof v !== "string") return [v, `conservationStatus: must be a string (got ${show(v)})`];
  const s = v.trim().toUpperCase();
  if (!(s in STATUSES))
    return [v, `conservationStatus: must be an IUCN code: ${Object.keys(STATUSES).join(", ")} (got ${show(v)})`];
  return [s, null];
}

function vPopulation(v) {
  let n = v;
  if (typeof v === "string") {
    if (!/^\s*-?\d+\s*$/.test(v)) return [v, `population: must be a whole number (got ${show(v)})`];
    n = Number(v);
  }
  if (typeof n !== "number" || !Number.isInteger(n))
    return [v, `population: must be a whole number (got ${show(v)})`];
  if (n < 0) return [n, `population: must be >= 0 (got ${n})`];
  if (n > LIMITS.populationMax) return [n, `population: must be <= ${LIMITS.populationMax} (got ${n})`];
  return [n, null];
}

function vHabitats(v) {
  let arr = v;
  if (typeof v === "string") arr = v.split(",");
  if (!Array.isArray(arr)) return [v, [`habitats: must be a list of strings (got ${show(v)})`]];
  const errors = [];
  const out = [];
  const seen = new Set();
  arr.forEach((h, i) => {
    if (typeof h !== "string") return errors.push(`habitats[${i}]: must be a string (got ${show(h)})`);
    const s = h.trim().replace(/\s+/g, " ").toLowerCase();
    if (s === "" && typeof v === "string") return; // tolerate "a,,b" / trailing comma
    const { min, max } = LIMITS.habitat;
    if (s.length < min || s.length > max)
      return errors.push(`habitats[${i}]: must be ${min}-${max} characters (got ${show(s)})`);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  });
  if (out.length > LIMITS.habitatsMax)
    errors.push(`habitats: at most ${LIMITS.habitatsMax} entries allowed (got ${out.length})`);
  return [out, errors.length ? errors : null];
}

const FIELD_VALIDATORS = {
  commonName: vCommonName,
  scientificName: vScientificName,
  kingdom: vKingdom,
  conservationStatus: vStatus,
  population: vPopulation,
  habitats: vHabitats,
};

function validateFields(input, fields) {
  const errors = [];
  const value = {};
  for (const f of fields) {
    if (input[f] === undefined) continue;
    const [norm, err] = FIELD_VALIDATORS[f](input[f]);
    if (err) errors.push(...[].concat(err));
    else value[f] = norm;
  }
  return { errors, value };
}

function checkObject(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return ["input: must be an object"];
  }
  return [];
}

function unknownFieldErrors(input, extraForbidden = []) {
  return Object.keys(input)
    .filter((k) => !ALLOWED_FIELDS.includes(k))
    .map((k) =>
      extraForbidden.includes(k) ? `${k}: cannot be set or changed` : `${k}: unknown field (allowed: ${ALLOWED_FIELDS.join(", ")})`
    );
}

// ---------- public API ----------

/** Validate a full document for insertion. */
export function validateCreate(input) {
  const objErr = checkObject(input);
  if (objErr.length) return { ok: false, errors: objErr };

  const errors = unknownFieldErrors(input, IMMUTABLE_FIELDS);
  for (const f of REQUIRED_FIELDS) {
    if (input[f] === undefined || input[f] === null || input[f] === "") errors.push(`${f}: is required`);
  }
  const present = ALLOWED_FIELDS.filter((f) => input[f] !== undefined && input[f] !== null && input[f] !== "");
  const res = validateFields(input, present);
  errors.push(...res.errors);

  if (errors.length) return { ok: false, errors };
  const value = { habitats: [], ...res.value };
  return { ok: true, value };
}

/** Validate a partial update ($set patch). At least one field is required. */
export function validateUpdate(patch) {
  const objErr = checkObject(patch);
  if (objErr.length) return { ok: false, errors: objErr };

  const errors = unknownFieldErrors(patch, IMMUTABLE_FIELDS);
  const keys = Object.keys(patch).filter((k) => ALLOWED_FIELDS.includes(k));
  if (Object.keys(patch).length === 0) errors.push("update: provide at least one field to change");

  for (const f of keys) {
    if ((patch[f] === null || patch[f] === "") && REQUIRED_FIELDS.includes(f)) errors.push(`${f}: cannot be empty`);
  }
  const res = validateFields(
    patch,
    keys.filter((f) => patch[f] !== null && patch[f] !== "")
  );
  errors.push(...res.errors);

  if (errors.length) return { ok: false, errors };
  const isEmpty = (f) => keys.includes(f) && (patch[f] === null || patch[f] === "");
  // population: null / "" means "remove the field" (it is optional)
  const unset = isEmpty("population") ? ["population"] : [];
  // habitats: null / "" means "clear the list"
  if (isEmpty("habitats")) res.value.habitats = [];
  return { ok: true, value: res.value, unset };
}

/**
 * Turn a user-supplied identifier into a MongoDB filter.
 * Accepts a 24-hex ObjectId or a scientific name.
 */
export function parseIdentifier(id) {
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, errors: ["identifier: provide an ObjectId or a scientific name"] };
  }
  const s = id.trim().replace(/\s+/g, " ");
  if (/^[0-9a-fA-F]{24}$/.test(s)) return { ok: true, filter: { _id: new ObjectId(s) } };
  const [norm, err] = vScientificName(s);
  if (err) return { ok: false, errors: [`identifier: not a valid ObjectId or scientific name (got ${show(s)})`] };
  return { ok: true, filter: { scientificName: norm } };
}

/** Validate list filters coming from the CLI. */
export function validateListOptions({ kingdom, status, search, limit } = {}) {
  const errors = [];
  const filter = {};
  if (kingdom !== undefined) {
    const [k, e] = vKingdom(kingdom);
    e ? errors.push(e) : (filter.kingdom = k);
  }
  if (status !== undefined) {
    const [s, e] = vStatus(status);
    e ? errors.push(e.replace("conservationStatus", "status")) : (filter.conservationStatus = s);
  }
  if (search !== undefined) {
    if (typeof search !== "string" || search.trim().length < 2 || search.length > 50) {
      errors.push("search: must be 2-50 characters");
    } else {
      // escape regex metacharacters - user input must never become a raw regex
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { commonName: { $regex: escaped, $options: "i" } },
        { scientificName: { $regex: escaped, $options: "i" } },
      ];
    }
  }
  let lim = 20;
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) errors.push(`limit: must be an integer 1-500 (got ${show(limit)})`);
    else lim = n;
  }
  return errors.length ? { ok: false, errors } : { ok: true, filter, limit: lim };
}
