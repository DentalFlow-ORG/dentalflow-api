"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("prisma/config");
function loadEnvFile(filePath) {
    if (!(0, node_fs_1.existsSync)(filePath)) {
        return {};
    }
    const content = (0, node_fs_1.readFileSync)(filePath, 'utf8');
    const entries = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) {
            return null;
        }
        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^"(.*)"$/, '$1');
        return [key, value];
    })
        .filter((entry) => entry !== null);
    return Object.fromEntries(entries);
}
const projectRoot = process.cwd();
const envFromFile = {
    ...loadEnvFile((0, node_path_1.join)(projectRoot, '.env')),
    ...loadEnvFile((0, node_path_1.join)(projectRoot, '.env.example')),
};
const databaseUrl = process.env.DATABASE_URL ?? envFromFile.DATABASE_URL ?? '';
exports.default = (0, config_1.defineConfig)({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations',
    },
    datasource: {
        url: databaseUrl,
    },
});
//# sourceMappingURL=prisma.config.js.map