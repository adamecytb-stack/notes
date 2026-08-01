/**
 * The sky.
 *
 * Two pieces of atmosphere that the rest of the app sits under: a starfield
 * that drifts too slowly to watch, and a moon drawn at the phase it actually
 * is tonight. Both are generated rather than drawn as assets — nothing here
 * loads over the network, which is the same promise the rest of the app makes.
 *
 * The moon being *real* is the point. It is different every night, it is the
 * same moon outside the window, and over a month of writing you watch it fill
 * and empty. A static crescent icon would be decoration; this is a clock.
 */

const NS = 'http://www.w3.org/2000/svg';

/* --------------------------------------------------------------- the moon */

/** Reference new moon: 2000 Jan 6, 18:14 UTC. */
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14) / 86_400_000;

/** Mean synodic month, in days. */
const SYNODIC = 29.530588853;

/**
 * Where the moon is in its cycle, 0–1.
 * 0 new · 0.25 first quarter · 0.5 full · 0.75 last quarter.
 */
export function moonPhase(when = Date.now()) {
  const days = when / 86_400_000 - NEW_MOON;
  return ((days / SYNODIC) % 1 + 1) % 1;
}

/** How much of the disc is lit, 0–1. Used for the glow, not the shape. */
export const illumination = (phase) => (1 - Math.cos(2 * Math.PI * phase)) / 2;

export function phaseName(phase) {
  const eighth = Math.floor(((phase + 1 / 16) % 1) * 8) % 8;
  return [
    'New moon',
    'Waxing crescent',
    'First quarter',
    'Waxing gibbous',
    'Full moon',
    'Waning gibbous',
    'Last quarter',
    'Waning crescent',
  ][eighth];
}

/**
 * The lit part of the disc, as one path.
 *
 * The outer edge is a semicircle; the terminator is an ellipse seen at an
 * angle, so its width is the cosine of the phase and it crosses the centre at
 * the quarters. Both arcs share their endpoints at the poles, which is what
 * makes a crescent and a gibbous the same two commands with different sweeps.
 */
function litPath(cx, cy, r, phase) {
  const cos = Math.cos(2 * Math.PI * phase);
  const rx = Math.abs(cos) * r;
  const waxing = phase < 0.5;

  // Outer limb: the right half when waxing, the left when waning. Sweep 1
  // runs clockwise on screen, so top-to-bottom with sweep 1 traces the right.
  const limbSweep = waxing ? 1 : 0;
  /*
   * The terminator returns bottom-to-top, which reverses the direction — so
   * the flag that keeps it on the lit side is the opposite of the limb's.
   * Before the quarter (cos > 0) it stays inside the lit half and the shape is
   * a crescent; after it, it crosses to the far side and the shape is gibbous.
   */
  const termSweep = cos > 0 ? 1 - limbSweep : limbSweep;

  return [
    `M ${cx} ${cy - r}`,
    `A ${r} ${r} 0 0 ${limbSweep} ${cx} ${cy + r}`,
    `A ${rx.toFixed(3)} ${r} 0 0 ${termSweep} ${cx} ${cy - r}`,
    'Z',
  ].join(' ');
}

/**
 * @param {number} size px
 * @param {number} phase 0–1
 * @returns {SVGElement} a moon at that phase, lit warm against a dim disc.
 */
export function moonSvg(size = 64, phase = moonPhase()) {
  const r = 46;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'moon');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${phaseName(phase)} tonight`);

  // The unlit disc stays faintly visible — earthshine, and it stops a thin
  // crescent reading as a stray comma.
  const disc = document.createElementNS(NS, 'circle');
  disc.setAttribute('cx', '50');
  disc.setAttribute('cy', '50');
  disc.setAttribute('r', String(r));
  disc.setAttribute('class', 'moon__disc');
  svg.appendChild(disc);

  const lit = document.createElementNS(NS, 'path');
  lit.setAttribute('d', litPath(50, 50, r, phase));
  lit.setAttribute('class', 'moon__lit');
  svg.appendChild(lit);

  /*
   * No maria. At the sizes this is drawn, any surface marking legible enough
   * to read as a sea also reads as a face — and the glow already does the work
   * of saying "moon" rather than "circle".
   */

  return svg;
}

/* ---------------------------------------------------------- the starfield */

/**
 * Deterministic per-night, so the sky is the same all evening and quietly
 * different tomorrow. Nobody will consciously notice; it is the difference
 * between a background and a place.
 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Builds the fixed starfield that everything else floats over.
 *
 * Stars cluster towards the top and thin out lower down, so the bottom of the
 * screen — where the thumb and the buttons live — stays quiet.
 */
export function starfield(node, { count = 90, night = Date.now() } = {}) {
  const rand = seeded(Math.floor(night / 86_400_000));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 160');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.setAttribute('class', 'sky__field');
  svg.setAttribute('aria-hidden', 'true');

  for (let i = 0; i < count; i++) {
    const star = document.createElementNS(NS, 'circle');
    const x = rand() * 100;
    // Squaring biases towards the top of the field.
    const y = rand() ** 1.7 * 160;
    const r = 0.12 + rand() ** 2.2 * 0.55;
    star.setAttribute('cx', x.toFixed(2));
    star.setAttribute('cy', y.toFixed(2));
    star.setAttribute('r', r.toFixed(3));
    star.setAttribute('class', 'sky__spark');
    star.style.setProperty('--twinkle', `${(6 + rand() * 10).toFixed(1)}s`);
    star.style.setProperty('--offset', `${(rand() * 10).toFixed(1)}s`);
    star.style.setProperty('--peak', (0.25 + rand() * 0.6).toFixed(2));
    // Staggered by height so the sky fills downwards, the way the eye expects
    // light to arrive, rather than switching on all at once.
    star.style.setProperty('--settle', `${(0.1 + (y / 160) * 0.7).toFixed(2)}s`);
    svg.appendChild(star);
  }

  node.replaceChildren(svg);
  return svg;
}
