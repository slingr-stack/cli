import { Args, Command } from '@oclif/core'
import fs from 'fs-extra'
import path from 'node:path'
import { execSync } from 'child_process'
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
                    // Prepare the environment before loading
                    await this.prepareEnvironment()
                    await this.loadDataset(datasource, dataset)
                    break
                default:
                    this.error(`Unknown action: ${action}`)
            }
        } catch (error) {
            this.error(`Failed to ${action} dataset: ${(error as Error).message}`)
        }
    }

    private async buildFramework(): Promise<void> {
        this.log('Building slingr-framework...')
        const currentDir = process.cwd()
        const nodeModulesPath = path.join(currentDir, 'node_modules', 'slingr-framework')

        this.log(`Looking for slingr-framework in: ${nodeModulesPath}`)

        if (!await fs.pathExists(nodeModulesPath)) {
            this.error('slingr-framework not found in node_modules. Please run npm install first.')
        }

        try {
            this.log('Building framework...')
            process.chdir(nodeModulesPath)

            execSync('npm run build', { stdio: 'inherit' })
        } catch (error) {
            this.error(`Failed to build framework: ${(error as Error).message}`)
        } finally {
            process.chdir(currentDir)
        }
    }

    private async generateCode(): Promise<void> {
        // Compile TypeScript code
        this.log('Compiling TypeScript code...')
        execSync('npm run build', { stdio: 'inherit' })
    }

    private async prepareEnvironment(): Promise<void> {
        // Check if we have package.json with slingr-framework dependency
        const packageJsonPath = path.join(process.cwd(), 'package.json')
        const packageJson = await fs.readJSON(packageJsonPath)

        if (!packageJson.dependencies?.['slingr-framework']) {
            this.error('This directory does not contain a Slingr application.')
        }

        // Check if node_modules exists, if not tell user to install dependencies
        const nodeModulesPath = path.join(process.cwd(), 'node_modules')
        if (!await fs.pathExists(nodeModulesPath)) {
            this.error('Dependencies not found. Please run "npm install" first to install the required dependencies.')
        }

        // Check if slingr-framework is specifically installed
        const frameworkPath = path.join(nodeModulesPath, 'slingr-framework')
        if (!await fs.pathExists(frameworkPath)) {
            this.error('slingr-framework not found in node_modules. Please run "npm install" to install dependencies.')
        }

        // Step 1: Build slingr-framework
        await this.buildFramework()

        // Step 2: Generate code
        await this.generateCode()
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

        // Validate Docker is running and PostgreSQL container is available
        await this.validateDockerInfrastructure(datasource)

        // Initialize the datasource with its configuration
        try {
            this.log(`Attempting to connect to database: ${JSON.stringify(dsConfig.getOptions(), null, 2)}`)
            await dsConfig.initialize(options)
        } catch (error) {
            const errorMessage = (error as Error).message
            this.log(`Connection failed with error: ${errorMessage}`)

            // Check if docker-compose.yml exists
            const dockerComposePath = path.join(process.cwd(), 'docker-compose.yml')
            const hasDockerCompose = await fs.pathExists(dockerComposePath)

            // Helper function to check if error contains connection refused
            const isConnectionRefused = (err: any): boolean => {
                // Check the main error
                if (err.code === 'ECONNREFUSED') return true
                if (err.message?.includes('ECONNREFUSED')) return true
                if (err.message?.includes('connection refused')) return true

                // Check nested errors in AggregateError
                if (err.errors && Array.isArray(err.errors)) {
                    return err.errors.some((nestedErr: any) => isConnectionRefused(nestedErr))
                }

                // Check cause property
                if (err.cause) {
                    return isConnectionRefused(err.cause)
                }

                return false
            }

            // Check for TypeORM initialization failures (usually connection issues)
            if (errorMessage.includes('Failed to initialize TypeORM DataSource')) {
                if (hasDockerCompose) {
                    this.error(`Cannot connect to database server. The database infrastructure exists but is not running.\n\nTo fix this, run one of the following commands:\n  - slingr run (to start the full application with infrastructure)\n  - docker-compose up -d (to start just the infrastructure services)`)
                } else {
                    this.error(`Cannot connect to database server. The database infrastructure has not been set up yet.\n\nTo fix this, you have two options:\n\n1. Simple option:\n  - slingr run (automatically generates infrastructure and starts the application)\n\n2. Step-by-step option:\n  - slingr infra:update --all (to generate docker-compose.yml and infrastructure files)\n  - Then run: slingr run OR docker-compose up -d`)
                }
            }

            // Check for connection refused errors
            if (isConnectionRefused(error)) {
                if (hasDockerCompose) {
                    this.error(`Cannot connect to database server. The database infrastructure exists but is not running.\n\nTo fix this, run one of the following commands:\n  - slingr run (to start the full application with infrastructure)\n  - docker-compose up -d (to start just the infrastructure services)`)
                } else {
                    this.error(`Cannot connect to database server. The database infrastructure has not been set up yet.\n\nTo fix this, you have two options:\n\n1. Simple option:\n  - slingr run (automatically generates infrastructure and starts the application)\n\n2. Step-by-step option:\n  - slingr infra:update --all (to generate docker-compose.yml and infrastructure files)\n  - Then run: slingr run OR docker-compose up -d`)
                }
            }

            // Check for database not found errors
            if (errorMessage.includes('database') && errorMessage.includes('does not exist')) {
                this.error(`Database infrastructure not found. The database server is not running or the database does not exist.\n\nTo fix this, run the following command:\n  - slingr run (to start the full application with infrastructure)`)
            }

            // Re-throw other errors
            throw error
        }

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

    /**
     * Validate that Docker is running and PostgreSQL container is available
     */
    private async validateDockerInfrastructure(datasource: string): Promise<void> {
        // Check if Docker is running
        try {
            execSync('docker info', { stdio: 'pipe' })
        } catch (error) {
            this.error(`Docker is not running. Please start Docker Desktop before running dataset commands.\n\nThe dataset command requires Docker to run the PostgreSQL infrastructure.`)
        }

        // Check if docker-compose.yml exists
        const dockerComposePath = path.join(process.cwd(), 'docker-compose.yml')
        if (!await fs.pathExists(dockerComposePath)) {
            this.error(`Docker infrastructure not found. Missing docker-compose.yml file.\n\nTo fix this, run one of the following commands:\n  - slingr infra:update --all (to generate infrastructure files)\n  - slingr run (to automatically generate and start infrastructure)`)
        }

        // Check if PostgreSQL container is running
        const serviceName = `${datasource}-db` // Docker service name format
        try {
            const result = execSync(`docker-compose ps -q ${serviceName}`, { stdio: 'pipe', encoding: 'utf8' })
            if (!result.trim()) {
                this.error(`PostgreSQL container '${serviceName}' is not running.\n\nTo fix this, run one of the following commands:\n  - slingr run (to start the full application with infrastructure)\n  - docker-compose up -d ${serviceName} (to start just the PostgreSQL service)`)
            }

            // Verify the container is actually running (not just exists)
            const statusResult = execSync(`docker-compose ps ${serviceName}`, { stdio: 'pipe', encoding: 'utf8' })
            if (!statusResult.includes('Up')) {
                this.error(`PostgreSQL container '${serviceName}' exists but is not running.\n\nTo fix this, run one of the following commands:\n  - slingr run (to start the full application with infrastructure)\n  - docker-compose up -d ${serviceName} (to start just the PostgreSQL service)`)
            }

            this.log(`✅ Docker infrastructure validated: PostgreSQL container '${serviceName}' is running`)
        } catch (error) {
            this.error(`Could not verify PostgreSQL container status.\n\nTo fix this, run one of the following commands:\n  - slingr run (to start the full application with infrastructure)\n  - docker-compose up -d (to start all infrastructure services)`)
        }
    }

}
