import { Args, Command, Flags } from '@oclif/core'
import fs from 'fs-extra'
import inquirer from 'inquirer'
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
    static examples = [
        '<%= config.bin %> <%= command.id %>',
        '<%= config.bin %> <%= command.id %> --file postgres.ts',
        '<%= config.bin %> <%= command.id %> -f mysql.ts'
    ]

    static flags = {
        file: Flags.string({
            char: 'f',
            description: 'Optional: Specific data source file to update',
            required: false
        })
    }

    private async readDataSources(specificFile?: string): Promise<DataSource[]> {
        const datasourcesDir = path.join(process.cwd(), 'src', 'dataSources')
        if (!fs.existsSync(datasourcesDir)) {
            throw new Error('No dataSources directory found. Make sure you have a src/dataSources/ folder.')
        }

        // Si se especifica un archivo, asegurarse de que tenga la extensión .ts
        const normalizeFileName = (file: string) => 
            file.endsWith('.ts') ? file : `${file}.ts`

        const files = specificFile ?
            [normalizeFileName(specificFile)] :
            (await fs.readdir(datasourcesDir)).filter(f => f.endsWith('.ts'))

        const dataSources: DataSource[] = []
        for (const file of files) {
            const filePath = path.join(datasourcesDir, file)
            const fileContent = await fs.readFile(filePath, 'utf-8')
            const extractRaw = (key: string): string | null => {
                const re = new RegExp(key + "\\s*:\\s*([^,\n]+)", 'i')
                const m = fileContent.match(re)
                return m ? m[1].trim() : null
            }
            const interpret = (raw: string | null): any => {
                if (!raw) return undefined
                raw = raw.replace(/,$/, '').trim()
                if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
                let m = raw.match(/parseInt\([^|]+\|\|\s*['"]([^'"]+)['"]\)/i)
                if (m) return parseInt(m[1], 10)
                m = raw.match(/process\.env\.[A-Z0-9_]+\s*\|\|\s*['"]([^'"]+)['"]/i)
                if (m) return m[1]
                m = raw.match(/^['"]([^'"]+)['"]$/)
                if (m) return m[1]
                m = raw.match(/^(\d+)$/)
                if (m) return parseInt(m[1], 10)
                return raw
            }
            const typeRaw = extractRaw('type')
            if (!typeRaw) continue
            let typeVal = (typeRaw.match(/['"]([^'"]+)['"]/i) || [null, typeRaw])[1].toLowerCase()
            if (typeVal === 'postgresql') typeVal = 'postgres'
            if (!['mysql', 'postgres', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(typeVal)) {
                continue
            }
            const name = file.replace('.ts', '')
            const dataSource: DataSource = {
                type: typeVal as DataSource['type'],
                name,
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
            dataSources.push(dataSource)
        }
        return dataSources
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
            const { flags } = await this.parse(InfraUpdate)
            this.log('Reading metadata and updating infrastructure configuration...')

            const dataSources = await this.readDataSources(flags.file)
            if (dataSources.length === 0) {
                this.log('No data sources found in configuration.')
                return
            }

            let selectedDataSources: DataSource[]

            // Si hay un solo datasource o se especificó un archivo, no preguntar
            if (dataSources.length === 1 || flags.file) {
                selectedDataSources = dataSources
                this.log(`Using data source: ${dataSources[0].name} (${dataSources[0].type})`)
            } else {
                // Si hay múltiples datasources, mostrar selección
                const answers = await inquirer.prompt([
                    {
                        type: 'checkbox',
                        name: 'selectedDataSources',
                        message: 'Select the data sources you want to update:',
                        choices: dataSources.map(ds => ({
                            name: `${ds.name} (${ds.type})`,
                            value: ds,
                            checked: true
                        }))
                    }
                ])

                selectedDataSources = answers.selectedDataSources as DataSource[]
                if (selectedDataSources.length === 0) {
                    this.log('No data sources selected. Exiting...')
                    return
                }
            }

            const dockerCompose = this.generateDockerCompose(selectedDataSources)
            const yamlContent = yaml.dump(dockerCompose)

            await fs.writeFile('docker-compose.yml', yamlContent)
            this.log('Successfully generated docker-compose.yml with database configurations.')
        } catch (error) {
            this.error((error as Error).message)
        }
    }
}
