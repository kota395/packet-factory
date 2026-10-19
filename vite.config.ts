import { fileURLToPath } from 'node:url';
import license from 'rollup-plugin-license';
import { defineConfig } from 'vitest/config';

// 依存ライブラリのライセンス方針(docs/tech-stack.md 参照)。
// ここに無いライセンスの依存がバンドルに入るとビルドが失敗する。
const ALLOWED_LICENSES = '(MIT OR Apache-2.0 OR BSD-2-Clause OR BSD-3-Clause OR ISC OR 0BSD)';

export default defineConfig(({ mode }) => ({
  // GitHub Pages ではリポジトリ名がパスに入る(/packet-factory/)。
  // 相対パスにしておけば、リポジトリ名や公開先が変わってもそのまま動く。
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  plugins: [
    {
      ...license({
        thirdParty: {
          includePrivate: false,
          allow: {
            test: ALLOWED_LICENSES,
            failOnUnlicensed: true,
            failOnViolation: true,
          },
          output: {
            file: fileURLToPath(new URL('./dist/THIRD_PARTY_LICENSES.txt', import.meta.url)),
          },
        },
      }),
      apply: 'build',
    },
  ],
  test: {
    // 通常のテストと、時間のかかるバランス確認ボット(npm run balance)を分ける
    include: mode === 'balance' ? ['scripts/**/*.test.ts'] : ['tests/**/*.test.ts'],
    testTimeout: mode === 'balance' ? 600_000 : 5_000,
  },
}));
