// Builds public/icons.svg, a sprite of the Carbon icons the viewer uses.
// Run after changing ICONS: node tools/build-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const ICONS = ['menu', 'close', 'add', 'arrow--left', 'arrow--right', 'renew', 'keyboard', 'terminal', 'maximize', 'minimize', 'link', 'chevron--right', 'search', 'checkmark', 'trash-can'];
const dir = new URL('../node_modules/@carbon/icons/svg/32/', import.meta.url);
const symbols = ICONS.map(name => {
  const svg = readFileSync(new URL(name + '.svg', dir), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '');
  return `<symbol id="${name}" viewBox="0 0 32 32">${inner}</symbol>`;
});
writeFileSync(new URL('../public/icons.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>\n`);
console.log('wrote public/icons.svg with', ICONS.length, 'icons');
