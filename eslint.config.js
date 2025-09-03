// Basic ESLint config for the project
module.exports = [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                // Node.js globals
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                global: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                // Haraka constants
                OK: 'readonly',
                DENY: 'readonly',
                DENYSOFT: 'readonly',
                DENYDISCONNECT: 'readonly',
                DISCONNECT: 'readonly'
            }
        },
        rules: {
            'no-await-in-loop': 0,
            'no-unused-vars': ['warn', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_', 'caughtErrorsIgnorePattern': '^_' }],
            'no-undef': 'error',
            'semi': ['error', 'always'],
            'quotes': ['error', 'single'],
            'indent': 'off', // Disable indent rule as the project uses mixed indentation
            'no-trailing-spaces': 'error',
            'eol-last': 'error'
        }
    }
];
