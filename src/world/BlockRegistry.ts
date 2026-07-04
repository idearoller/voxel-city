/**
 * Block type definitions. Pure data, no Three.js.
 */

export type NeonChannel = 0 | 1 | 2 | 3;

export interface BlockDef {
  id: number;
  name: string;
  /** RGB in [0, 1]. */
  color: [number, number, number];
  solid: boolean;
  opaque: boolean;
  emissive: boolean;
  neonChannel?: NeonChannel;
  /** Routed into the mesher's dedicated road group (wet-look PBR material) instead of solid. */
  road?: boolean;
}

function rgb(r: number, g: number, b: number): [number, number, number] {
  return [r / 255, g / 255, b / 255];
}

export const AIR = 0;
export const CONCRETE = 1;
export const ASPHALT = 2;
export const SIDEWALK = 3;
export const GLASS_DARK = 4;
export const WINDOW_LIT = 5;
export const NEON_PINK = 6;
export const NEON_CYAN = 7;
export const NEON_YELLOW = 8;
export const NEON_PURPLE = 9;
export const METAL = 10;
export const PARK_GRASS = 11;
export const TREE_LEAF = 12;
export const TREE_TRUNK = 13;
export const ELEVATOR_SHAFT = 14;
export const GRAVEL = 15;
export const SHOP_COUNTER = 16;
export const SHOP_SHELF = 17;

const BLOCK_LIST: BlockDef[] = [
  { id: AIR, name: 'AIR', color: rgb(0, 0, 0), solid: false, opaque: false, emissive: false },
  {
    id: CONCRETE,
    name: 'CONCRETE',
    color: rgb(96, 92, 98),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: ASPHALT,
    name: 'ASPHALT',
    color: rgb(40, 38, 44),
    solid: true,
    opaque: true,
    emissive: false,
    road: true,
  },
  {
    id: SIDEWALK,
    name: 'SIDEWALK',
    color: rgb(118, 112, 120),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: GLASS_DARK,
    name: 'GLASS_DARK',
    color: rgb(30, 34, 48),
    solid: true,
    opaque: false,
    emissive: false,
  },
  {
    id: WINDOW_LIT,
    name: 'WINDOW_LIT',
    color: rgb(255, 214, 120),
    solid: true,
    opaque: true,
    emissive: true,
  },
  {
    id: NEON_PINK,
    name: 'NEON_PINK',
    color: rgb(255, 45, 149),
    solid: true,
    opaque: true,
    emissive: true,
    neonChannel: 0,
  },
  {
    id: NEON_CYAN,
    name: 'NEON_CYAN',
    color: rgb(45, 245, 255),
    solid: true,
    opaque: true,
    emissive: true,
    neonChannel: 1,
  },
  {
    id: NEON_YELLOW,
    name: 'NEON_YELLOW',
    color: rgb(255, 231, 66),
    solid: true,
    opaque: true,
    emissive: true,
    neonChannel: 2,
  },
  {
    id: NEON_PURPLE,
    name: 'NEON_PURPLE',
    color: rgb(170, 60, 255),
    solid: true,
    opaque: true,
    emissive: true,
    neonChannel: 3,
  },
  {
    id: METAL,
    name: 'METAL',
    color: rgb(140, 144, 152),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: PARK_GRASS,
    name: 'PARK_GRASS',
    color: rgb(56, 120, 80),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: TREE_LEAF,
    name: 'TREE_LEAF',
    color: rgb(40, 110, 70),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: TREE_TRUNK,
    name: 'TREE_TRUNK',
    color: rgb(74, 54, 42),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: ELEVATOR_SHAFT,
    name: 'ELEVATOR_SHAFT',
    color: rgb(90, 100, 110),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: GRAVEL,
    name: 'GRAVEL',
    color: rgb(150, 140, 120),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: SHOP_COUNTER,
    name: 'SHOP_COUNTER',
    color: rgb(120, 84, 56),
    solid: true,
    opaque: true,
    emissive: false,
  },
  {
    id: SHOP_SHELF,
    name: 'SHOP_SHELF',
    color: rgb(104, 108, 118),
    solid: true,
    opaque: true,
    emissive: false,
  },
];

const BLOCKS_BY_ID: ReadonlyMap<number, BlockDef> = new Map(BLOCK_LIST.map((b) => [b.id, b]));

/** Look up a block definition by id. Falls back to AIR for unknown ids. */
export function getBlock(id: number): BlockDef {
  return BLOCKS_BY_ID.get(id) ?? (BLOCKS_BY_ID.get(AIR) as BlockDef);
}

export { BLOCK_LIST as BLOCK_DEFS };
