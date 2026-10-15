import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.next/**', '.expo/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
);
