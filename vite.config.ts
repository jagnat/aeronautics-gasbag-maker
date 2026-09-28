import { defineConfig } from 'vite';

// relative asset paths so the build works under a github pages subpath
export default defineConfig({
  base: './',
});
