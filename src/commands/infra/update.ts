import { Command } from '@oclif/core'
import fs from 'fs-extra'
import * as yaml from 'js-yaml'
import * as path from 'path'

interface DataSource {
    // Allowed DB types
    type: 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql' | 'oracle'
    name: string
    managed?: boolean
    host?: string
    port?: number
    username?: string
    password?: string
    database?: string
    logging?: boolean
    synchronize?: boolean
    connectTimeout?: number
}

export default class InfraUpdate extends Command {
    static description = 'Update infrastructure configuration based on metadata'
    static examples = ['<%= config.bin %> <%= command.id %>']

    private async readDataSources(): Promise<DataSource[]> {
        const configPath = path.join(process.cwd(), 'src', 'config', 'datasource.ts')
        if (!fs.existsSync(configPath)) {
            throw new Error('No datasource configuration found. Make sure you have a datasource.ts file in src/config/.')
        }

        // Read the file content
        const fileContent = await fs.readFile(configPath, 'utf-8')

        // Extract the TypeORMSqlDataSource configuration with a few heuristics.
        const extractRaw = (key: string): string | null => {
            const re = new RegExp(key + "\\s*:\\s*([^,\n]+)", 'i')
            const m = fileContent.match(re)
            return m ? m[1].trim() : null
        }

        const interpret = (raw: string | null): any => {
            if (!raw) return undefined
            // remove trailing commas
            raw = raw.replace(/,$/, '').trim()
            // boolean
            if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
            // parseInt(...) || '1234' patterns
            let m = raw.match(/parseInt\([^|]+\|\|\s*['"]([^'"]+)['"]\)/i)
            if (m) return parseInt(m[1], 10)
            // process.env.SOMETHING || 'default'
            m = raw.match(/process\.env\.[A-Z0-9_]+\s*\|\|\s*['"]([^'"]+)['"]/i)
            if (m) return m[1]
            // string literal
            m = raw.match(/^['"]([^'"]+)['"]$/)
            if (m) return m[1]
            // numeric literal
            m = raw.match(/^(\d+)$/)
            if (m) return parseInt(m[1], 10)
            // fallback: return raw as-is (could be an expression)
            return raw
        }

        const typeRaw = extractRaw('type')
        if (!typeRaw) throw new Error('Could not find database type in configuration')
        let typeVal = (typeRaw.match(/['"]([^'"]+)['"]/i) || [null, typeRaw])[1].toLowerCase()
        // normalize legacy name
        if (typeVal === 'postgresql') typeVal = 'postgres'
        if (!['mysql', 'postgres', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(typeVal)) {
            throw new Error(`Unsupported database type: ${typeVal}. Supported types: postgres, mysql, mariadb, sqlite, mssql, oracle.`)
        }

        const dataSource: DataSource = {
            type: typeVal as DataSource['type'],
            name: 'main',
            managed: interpret(extractRaw('managed')) ?? undefined,
            host: interpret(extractRaw('host')) ?? undefined,
            port: interpret(extractRaw('port')) ?? (typeVal === 'mysql' ? 3306 : 5432),
            username: interpret(extractRaw('username')) ?? (typeVal === 'mysql' ? 'root' : 'postgres'),
            password: interpret(extractRaw('password')) ?? (typeVal === 'mysql' ? 'root' : 'postgres'),
            database: interpret(extractRaw('database')) ?? 'slingr',
            logging: interpret(extractRaw('logging')) ?? undefined,
            synchronize: interpret(extractRaw('synchronize')) ?? undefined,
            connectTimeout: interpret(extractRaw('connectTimeout')) ?? undefined,
        }

        return [dataSource]
    }

    private generateDockerCompose(dataSources: DataSource[]): Record<string, any> {
        const compose: {
            version: string
            services: Record<string, any>
            volumes: Record<string, null>
        } = {
            version: '3.8',
            services: {},
            volumes: {},
        }

        dataSources.forEach(ds => {
            switch (ds.type) {
                case 'postgres':
                    compose.services[`${ds.name}-db`] = {
                        image: 'postgres:15-alpine',
                        ports: [`${ds.port || 5432}:5432`],
                        volumes: [`${ds.name}-data:/var/lib/postgresql/data`],
                        environment: {
                            POSTGRES_USER: ds.username || 'postgres',
                            POSTGRES_PASSWORD: ds.password || 'postgres',
                            POSTGRES_DB: ds.database || 'slingr',
                        },
                        healthcheck: {
                            test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres}"],
                            interval: "10s",
                            timeout: "5s",
                            retries: 5
                        }
                    }
                    compose.volumes[`${ds.name}-data`] = null
                    break
                case 'mysql':
                    {
                        const env: Record<string, any> = {
                            MYSQL_DATABASE: ds.database || 'slingr',
                        }
                        if ((ds.username || '').toLowerCase() === 'root') {
                            env.MYSQL_ROOT_PASSWORD = ds.password || 'root'
                        } else {
                            env.MYSQL_USER = ds.username || 'slingr'
                            env.MYSQL_PASSWORD = ds.password || 'slingr'
                        }

                        compose.services[`${ds.name}-db`] = {
                            image: 'mysql:8.0',
                            ports: [`${ds.port || 3306}:3306`],
                            volumes: [`${ds.name}-data:/var/lib/mysql`],
                            environment: env,
                            healthcheck: {
                                test: ["CMD", "mysqladmin", "ping", "-h", "localhost"],
                                timeout: "20s",
                                retries: 10
                            }
                        }
                        compose.volumes[`${ds.name}-data`] = null
                    }
                    break
                case 'mariadb':
                    {
                        const env: Record<string, any> = {
                            MARIADB_DATABASE: ds.database || 'slingr',
                        }
                        if ((ds.username || '').toLowerCase() === 'root') {
                            env.MARIADB_ROOT_PASSWORD = ds.password || 'root'
                        } else {
                            env.MARIADB_USER = ds.username || 'slingr'
                            env.MARIADB_PASSWORD = ds.password || 'slingr'
                        }

                        compose.services[`${ds.name}-db`] = {
                            image: 'mariadb:10.6',
                            ports: [`${ds.port || 3306}:3306`],
                            volumes: [`${ds.name}-data:/var/lib/mysql`],
                            environment: env
                        }
                        compose.volumes[`${ds.name}-data`] = null
                    }
                    break
                case 'sqlite':
                    // SQLite is file-based, no DB service necessary
                    this.log(`Skipping docker service for sqlite datasource '${ds.name}' (file-based).`)
                    break
                case 'mssql':
                    compose.services[`${ds.name}-db`] = {
                        image: 'mcr.microsoft.com/mssql/server:2019-latest',
                        ports: [`${ds.port || 1433}:1433`],
                        environment: {
                            SA_PASSWORD: ds.password || 'YourStrong!Passw0rd',
                            ACCEPT_EULA: 'Y'
                        }
                    }
                    compose.volumes[`${ds.name}-data`] = null
                    break
                case 'oracle':
                    // Use a common Oracle XE image; user may need to adjust licenses/credentials
                    compose.services[`${ds.name}-db`] = {
                        image: 'gvenzl/oracle-xe:18-slim',
                        ports: [`${ds.port || 1521}:1521`],
                        environment: {
                            ORACLE_PASSWORD: ds.password || 'oracle'
                        }
                    }
                    compose.volumes[`${ds.name}-data`] = null
                    break
                default:
                    this.warn(`Unsupported database type: ${ds.type}. Only PostgreSQL and MySQL are supported.`)
            }
        })

        return compose
    }

    async run(): Promise<void> {
        try {
            this.log('Reading metadata and updating infrastructure configuration...')

            const dataSources = await this.readDataSources()
            if (dataSources.length === 0) {
                this.log('No data sources found in configuration.')
                return
            }

            const dockerCompose = this.generateDockerCompose(dataSources)
            const yamlContent = yaml.dump(dockerCompose)

            await fs.writeFile('docker-compose.yml', yamlContent)
            this.log('Successfully generated docker-compose.yml with database configurations.')
        } catch (error) {
            this.error((error as Error).message)
        }
    }
}
