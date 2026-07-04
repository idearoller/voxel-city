import { defineConfig } from 'vite';

// Dev serves at root; production build targets the GitHub Pages project
// subpath (https://idearoller.github.io/voxel-city/).
export default defineConfig(({ command }) => ({
  root: '.',
  base: command === 'build' ? '/voxel-city/' : '/',
  build: {
    target: 'es2022',
  },
}));
