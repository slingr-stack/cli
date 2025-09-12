import { Args, Command } from '@oclif/core'
import fs from 'fs-extra'
import path from 'node:path'
import { TypeORMSqlDataSource } from 'slingr-framework'
import { DataSource, EntitySchema } from 'typeorm'
import { JsonlDatasetLoader, discoverModels } from '../utils/jsonl-loader.js'

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

    private async loadDataset(datasource: string, dataset: string): Promise<void> {
        this.log(`Loading dataset '${dataset}' into datasource '${datasource}'...`)

        // Initialize the JSONL loader
        const loader = new JsonlDatasetLoader()

        // Path to the compiled JavaScript files
        const distPath = path.join(process.cwd(), 'dist')
        
        // Auto-discover models from compiled JS files
        const modelMap = await discoverModels(distPath)
        
        if (Object.keys(modelMap).length === 0) {
            this.error('No models found. Please ensure your models are compiled (run npm run build) and extend BaseModel.')
        }

        this.log(`Discovered ${Object.keys(modelMap).length} models:`, Object.keys(modelMap))

        // Dataset directory path
        const datasetPath = path.join(process.cwd(), 'datasets', `${datasource}-${dataset}`)

        // Load dataset using the new JSONL loader
        const loadResults = await loader.loadDataset({
            datasetPath,
            modelMap,
            validateRecords: true,
            verbose: true
        })

        if (loadResults.length === 0) {
            this.error('No compatible JSONL files found or no models matched the file names.')
        }

        // Import the datasource module from compiled JS
        const dsModulePath = path.join(process.cwd(), 'dist', 'dataSources', `${datasource}.js`)
        const dsModule = require(dsModulePath)
        const dsConfig = dsModule[`${datasource}DataSource`] as TypeORMSqlDataSource

        if (!dsConfig) {
            this.error(`Could not find datasource instance ${datasource}DataSource in ${dsModulePath}`)
        }

        // Create EntitySchemas for each model we found data for
        const entities: EntitySchema[] = []
        for (const result of loadResults) {
            if (result.records.length > 0) {
                const ModelClass = modelMap[result.modelName]
                const sampleRecord = loader.convertToDbFormat([result.records[0]], false)[0]
                const schema = loader.inferDbSchema(sampleRecord)
                
                // Create EntitySchema with inferred columns
                const entitySchema = new EntitySchema({
                    name: result.modelName,
                    tableName: result.modelName.toLowerCase(),
                    target: ModelClass,
                    columns: this.createColumnsFromSchema(schema)
                })
                
                entities.push(entitySchema)
            }
        }

        // Get the datasource options and add the entities
        const options = {
            ...dsConfig.getOptions(),
            entities
        }

        // Initialize the datasource with its configuration
        await dsConfig.initialize(options)
        const dataSource = dsConfig.getTypeORMDataSource()

        if (!dataSource || !dataSource.isInitialized) {
            this.error('DataSource failed to initialize')
        }

        this.log('DataSource initialized successfully')

        // Process each load result using auto-commit (no explicit transactions)
        try {
            for (const result of loadResults) {
                if (result.errorCount > 0) {
                    this.log(`⚠️  Model ${result.modelName} has ${result.errorCount} validation errors:`)
                    for (const error of result.errors) {
                        this.log(`   Record ${error.recordIndex + 1}: ${JSON.stringify(error.validationErrors)}`)
                    }
                }

                if (result.successCount === 0) {
                    this.log(`⚠️  No valid records found for ${result.modelName}, skipping table creation.`)
                    continue
                }

                this.log(`📊 Processing ${result.modelName}: ${result.successCount} valid records`)

                // Convert model instances to database format
                const dbRecords = loader.convertToDbFormat(result.records, false)

                if (dbRecords.length === 0) {
                    continue
                }

                // Infer database schema from the first record
                const schema = loader.inferDbSchema(dbRecords[0])

                // Drop and recreate the table
                const tableName = result.modelName.toLowerCase()
                await dataSource.query(`DROP TABLE IF EXISTS "${tableName}";`)

                // Create table with inferred schema
                const columns = Object.entries(schema)
                    .map(([col, type]) => `${col} ${type}`)
                    .join(',\n    ')

                const createTableSQL = `CREATE TABLE "${tableName}" (\n    ${columns}\n);`
                this.log('Creating table with SQL:')
                this.log(createTableSQL)
                await dataSource.query(createTableSQL)

                // Insert the records
                if (dbRecords.length > 0) {
                    const columns = Object.keys(dbRecords[0]).join(', ')
                    const values = dbRecords.map(record => {
                        const vals = Object.values(record).map(val =>
                            val === null || val === undefined ? 'NULL' :
                                typeof val === 'string' ? `'${val.replace(/'/g, "''")}'` :
                                    val
                        ).join(', ')
                        return `(${vals})`
                    }).join(',\n    ')

                    const insertSQL = `INSERT INTO "${tableName}" (${columns}) VALUES\n    ${values};`
                    this.log(`Inserting ${dbRecords.length} records...`)
                    await dataSource.query(insertSQL)
                }

                // Immediately verify the data was saved
                const count = await dataSource.query(`SELECT COUNT(*) as count FROM "${tableName}";`)
                this.log(`✅ Successfully loaded ${result.successCount} records for ${result.modelName}`)
                this.log(`✅ Verified: Table "${tableName}" contains ${count[0].count} records`)
            }

            // Print summary
            const totalSuccess = loadResults.reduce((sum, r) => sum + r.successCount, 0)
            const totalErrors = loadResults.reduce((sum, r) => sum + r.errorCount, 0)

            this.log(`
🎉 Successfully loaded dataset '${dataset}' into datasource '${datasource}'`)
            this.log(`📈 Summary: ${totalSuccess} records loaded, ${totalErrors} errors`)

        } catch (error) {
            this.error(`Failed to load dataset: ${(error as Error).message}`)
        } finally {
            // Clean up by closing the datasource connection
            if (dataSource.isInitialized) {
                // Add delay to ensure all operations complete
                this.log('⏳ Finalizing database operations...')
                await new Promise(resolve => setTimeout(resolve, 2000))

                await dataSource.destroy()
                this.log('🔌 Database connection closed')
            }
        }
    }

    /**
     * Create TypeORM column definitions from inferred schema
     */
    private createColumnsFromSchema(schema: Record<string, string>): Record<string, any> {
        const columns: Record<string, any> = {}

        for (const [columnName, sqlType] of Object.entries(schema)) {
            let typeormType: string
            let isPrimary = false

            switch (sqlType) {
                case 'INTEGER':
                    typeormType = 'int'
                    break
                case 'REAL':
                    typeormType = 'float'
                    break
                case 'BOOLEAN':
                    typeormType = 'boolean'
                    break
                default:
                    typeormType = 'varchar'
            }

            // Assume 'id' column is primary key
            if (columnName === 'id') {
                isPrimary = true
            }

            columns[columnName] = {
                type: typeormType,
                primary: isPrimary,
                nullable: !isPrimary
            }
        }

        return columns
    }

}
