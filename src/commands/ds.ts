import { Args, Command } from '@oclif/core'
import fs from 'fs-extra'
import path from 'node:path'
import { TypeORMSqlDataSource } from 'slingr-framework'
import { DataSource, EntitySchema, EntityMetadata } from 'typeorm'
import { glob } from 'glob'

export default class Ds extends Command {
    static description = 'Manage datasets for datasources'

    static examples = [
        'slingr ds postgres load',
        'slingr ds postgres load custom-dataset',
        'slingr ds mysql load default'
    ]

    static args = {
        datasource: Args.string({
            description: 'Name of the datasource to manage',
            required: true
        }),
        action: Args.string({
            description: 'Action to perform (load)',
            options: ['load'],
            required: true
        }),
        dataset: Args.string({
            description: 'Name of the dataset to load (defaults to "default")',
            required: false,
            default: 'default'
        })
    }

    async run(): Promise<void> {
        const { args } = await this.parse(Ds)
        const { datasource, action, dataset } = args

        // Verify we're in a Slingr app directory
        const pkgPath = path.join(process.cwd(), 'package.json')
        if (!await fs.pathExists(pkgPath)) {
            this.error('Not in a Slingr application directory. Please run this command from your app\'s root directory.')
        }

        // Check if the datasource exists
        const dsPath = path.join(process.cwd(), 'src', 'dataSources', `${datasource}.ts`)
        if (!await fs.pathExists(dsPath)) {
            this.error(`Datasource ${datasource} not found. Expected file at: ${dsPath}`)
        }

        // Check if the dataset directory exists
        const datasetPath = path.join(process.cwd(), 'datasets', `${datasource}-${dataset}`)
        if (!await fs.pathExists(datasetPath)) {
            this.error(`Dataset not found at: ${datasetPath}`)
        }

        try {
            switch (action) {
                case 'load':
                    await this.loadDataset(datasource, dataset)
                    break
                default:
                    this.error(`Unknown action: ${action}`)
            }
        } catch (error) {
            this.error(`Failed to ${action} dataset: ${(error as Error).message}`)
        }
    }

    private async findEntities(): Promise<EntitySchema[]> {
        const distPath = path.join(process.cwd(), 'dist')
        const srcPath = path.join(process.cwd(), 'src', 'data')
        const entities: EntitySchema[] = []

        // Intentar cargar desde dist primero (compilado)
        if (await fs.pathExists(distPath)) {
            const entityFiles = await glob(path.join(distPath, 'data', '**', '*.js'))
            for (const file of entityFiles) {
                try {
                    const module = require(file)
                    const exports = Object.values(module)
                    for (const exp of exports) {
                        if (typeof exp === 'function' && exp.prototype && exp.name) {
                            // Crear un EntitySchema para cada modelo Slingr
                            const schema = new EntitySchema({
                                name: exp.name,
                                tableName: exp.name.toLowerCase(),
                                target: exp,
                                columns: {
                                    // Nota: usando snake_case para nombres de columnas en PostgreSQL
                                    id: {
                                        type: String,
                                        primary: true
                                    },
                                    first_name: {
                                        type: String,
                                        name: 'first_name'
                                    },
                                    last_name: {
                                        type: String,
                                        name: 'last_name'
                                    },
                                    email: { type: String },
                                    age: { type: Number },
                                    parent_email: {
                                        type: String,
                                        name: 'parent_email',
                                        nullable: true
                                    },
                                    internal_id: {
                                        type: String,
                                        name: 'internal_id',
                                        nullable: true
                                    },
                                    phone_number: {
                                        type: String,
                                        name: 'phone_number',
                                        nullable: true
                                    },
                                    additional_info: {
                                        type: String,
                                        name: 'additional_info',
                                        nullable: true
                                    },
                                    is_active: {
                                        type: Boolean,
                                        name: 'is_active',
                                        nullable: true
                                    }
                                }
                            })
                            entities.push(schema)
                        }
                    }
                } catch (error) {
                    this.warn(`Failed to load entity from file: ${file}: ${error}`)
                }
            }
        }

        if (entities.length === 0) {
            this.warn('No entities found in either dist/ or src/')
        }

        return entities
    }

    private async loadDataset(datasource: string, dataset: string): Promise<void> {
        this.log(`Loading dataset '${dataset}' into datasource '${datasource}'...`)

        // Detect entities automatically
        const entities = await this.findEntities()

        // Find all JSONL files in the dataset directory
        const datasetPath = path.join(process.cwd(), 'datasets', `${datasource}-${dataset}`)
        const files = await fs.readdir(datasetPath)
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

        if (jsonlFiles.length === 0) {
            this.error(`No JSONL files found in dataset directory: ${datasetPath}`)
        }

        // Import the datasource module
        const dsModulePath = path.join(process.cwd(), 'src', 'dataSources', `${datasource}.ts`)
        const dsModule = require(dsModulePath)
        const dsConfig = dsModule[`${datasource}DataSource`] as TypeORMSqlDataSource

        if (!dsConfig) {
            this.error(`Could not find datasource instance ${datasource}DataSource in ${dsModulePath}`)
        }

        // Get the datasource options and add the entities
        const options = {
            ...dsConfig.getOptions(),
            entities
        }

        // Initialize the datasource with its configuration
        await dsConfig.initialize(options)

        // Access internal TypeORM DataSource after initialization
        const dataSource = (dsConfig as any).typeormDataSource as DataSource

        if (!dataSource?.isInitialized) {
            this.error('DataSource failed to initialize')
        }

        this.log('DataSource initialized successfully')

        // Set up a queryRunner for transaction management
        const queryRunner = dataSource.createQueryRunner()
        await queryRunner.connect()

        try {
            // Start a transaction for the entire process
            await queryRunner.startTransaction()

            // Process each JSONL file
            for (const file of jsonlFiles) {
                const modelName = path.basename(file, '.jsonl')
                this.log(`Loading data for model: ${modelName}`)

                try {
                    // Read and parse the JSONL file
                    const filePath = path.join(datasetPath, file)
                    const content = await fs.readFile(filePath, 'utf8')
                    const records = content.split('\n')
                        .filter(line => line.trim())
                        .map(line => {
                            const data = JSON.parse(line)
                            // Convert property names to snake_case
                            return {
                                id: data.id,
                                first_name: data.firstName,
                                last_name: data.lastName,
                                email: data.email,
                                age: data.age,
                                parent_email: data.parentEmail,
                                internal_id: data.internalId,
                                phone_number: data.phoneNumber,
                                additional_info: data.additionalInfo,
                                is_active: data.isActive
                            }
                        })

                    // Find the corresponding entity
                    const entity = entities.find(e => e.options.name === modelName)
                    if (!entity) {
                        throw new Error(`No entity found for model: ${modelName}`)
                    }

                    this.log(`Found entity: ${entity.options.name}`)
                    this.log('Creating table...')

                    // Drop and recreate the table
                    await queryRunner.query(`DROP TABLE IF EXISTS "${modelName.toLowerCase()}";`)

                    const createTableSQL = `CREATE TABLE "${modelName.toLowerCase()}" (
                        id TEXT PRIMARY KEY,
                        first_name TEXT,
                        last_name TEXT,
                        email TEXT,
                        age INTEGER,
                        parent_email TEXT,
                        internal_id TEXT,
                        phone_number TEXT,
                        additional_info TEXT,
                        is_active BOOLEAN
                    );`
                    this.log(createTableSQL)
                    await queryRunner.query(createTableSQL)

                    // Insert the records
                    if (records.length > 0) {
                        const columns = Object.keys(records[0]).join(', ')
                        const values = records.map(record => {
                            const vals = Object.values(record).map(val =>
                                val === null || val === undefined ? 'NULL' :
                                    typeof val === 'string' ? `'${val.replace(/'/g, "''")}'` :
                                        val
                            ).join(', ')
                            return `(${vals})`
                        }).join(',\n')

                        const insertSQL = `INSERT INTO "${modelName.toLowerCase()}" (${columns}) VALUES ${values};`
                        this.log('Executing insert:')
                        this.log(insertSQL)
                        await queryRunner.query(insertSQL)
                    }

                    this.log(`Successfully loaded ${records.length} records for ${modelName}`)
                } catch (error) {
                    this.error(`Failed to process model ${modelName}: ${error}`)
                }
            }

            // If everything went well, commit the transaction
            await queryRunner.commitTransaction()
            this.log(`\nSuccessfully loaded dataset '${dataset}' into datasource '${datasource}'`)

        } catch (error) {
            // If we had any error, roll back the entire transaction
            this.log('Rolling back transaction due to error')
            await queryRunner.rollbackTransaction()
            throw error
        } finally {
            // Release the query runner and close the connection
            await queryRunner.release()

            // Clean up by closing the datasource connection
            if (dataSource.isInitialized) {
                await dataSource.destroy()
            }
        }
    }
}
