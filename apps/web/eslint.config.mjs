import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
export default tseslint.config(...tseslint.configs.recommended,...pluginVue.configs['flat/essential'],{files:['**/*.vue'],languageOptions:{parserOptions:{parser:tseslint.parser}}},{ignores:['dist/**']});
