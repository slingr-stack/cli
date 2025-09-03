import { Command } from '@oclif/core'
import fs from 'fs-extra'
import * as yaml from 'js-yaml'
import * as path from 'path'

interface DataSource {
    type: 'postgresql' | 'mysql'  
    name: string
    config: {
        port?: number
        username?: string
        password?: string
        database?: string
    }
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

        // Extract the TypeORMSqlDataSource configuration
        const typeMatch = fileContent.match(/type:\s*['"]([^'"]+)['"]/);
        if (!typeMatch) {
            throw new Error('Could not find database type in configuration')
        }

        const dbType = typeMatch[1].toLowerCase()
        if (dbType !== 'mysql' && dbType !== 'postgresql') {
            throw new Error(`Unsupported database type: ${dbType}. Only MySQL and PostgreSQL are supported.`)
        }

        // Create a DataSource object from the TypeORMSqlDataSource configuration
        const dataSource: DataSource = {
            type: dbType as 'mysql' | 'postgresql',
            name: 'main',
            config: {
                port: dbType === 'mysql' ? 3306 : 5432,
                username: dbType === 'mysql' ? 'root' : 'postgres',
                password: dbType === 'mysql' ? 'root' : 'postgres',
                database: 'slingr'
            }
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
            switch (ds.type.toLowerCase()) {
                case 'postgresql':
                    compose.services[`${ds.name}-db`] = {
                        image: 'postgres:15-alpine',
                        ports: [`${ds.config.port || 5432}:5432`],
                        volumes: [`${ds.name}-data:/var/lib/postgresql/data`],
                        environment: {
                            POSTGRES_USER: ds.config.username || 'postgres',
                            POSTGRES_PASSWORD: ds.config.password || 'postgres',
                            POSTGRES_DB: ds.config.database || 'slingr',
                        },
                        healthcheck: {
                            test: ["CMD-SHELL", "pg_isready -U postgres"],
                            interval: "10s",
                            timeout: "5s",
                            retries: 5
                        }
                    }
                    compose.volumes[`${ds.name}-data`] = null
                    break
                case 'mysql':
                    compose.services[`${ds.name}-db`] = {
                        image: 'mysql:8.0',
                        ports: [`${ds.config.port || 3306}:3306`],
                        volumes: [`${ds.name}-data:/var/lib/mysql`],
                        environment: {
                            MYSQL_ROOT_PASSWORD: ds.config.password || 'root',
                            MYSQL_USER: ds.config.username || 'slingr',
                            MYSQL_PASSWORD: ds.config.password || 'slingr',
                            MYSQL_DATABASE: ds.config.database || 'slingr',
                        },
                        healthcheck: {
                            test: ["CMD", "mysqladmin", "ping", "-h", "localhost"],
                            timeout: "20s",
                            retries: 10
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
