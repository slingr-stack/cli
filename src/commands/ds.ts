import { Args, Command } from '@oclif/core'
import fs from 'fs-extra'
import path from 'node:path'
import { execSync } from 'child_process'
import { TypeORMSqlDataSource } from 'slingr-framework'
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



    private async generateCode(): Promise<void> {
        // Compile TypeScript code
        this.log('Compiling TypeScript code...')
        execSync('npm run build', { stdio: 'inherit' })
    }

    private async ensureDatabaseDependencies(datasource: string): Promise<void> {
        // Get the datasource type by reading the datasource file
        const dsPath = path.join(process.cwd(), 'src', 'dataSources', `${datasource}.ts`)
        const content = await fs.readFile(dsPath, 'utf-8')

        // Extract database type from the configuration
        const typeMatch = content.match(/type:\s*['"]([^'"]+)['"]/)
        if (!typeMatch) {
            this.log('Could not determine database type from datasource configuration')
            return
        }

        let dbType = typeMatch[1].toLowerCase()
        if (dbType === 'postgresql') dbType = 'postgres'

        // Check package.json for required dependencies
        const packageJsonPath = path.join(process.cwd(), 'package.json')
        const packageJson = await fs.readJSON(packageJsonPath)

        const dependencies = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies
        }

        let packageToInstall: string | null = null

        // Determine which package is needed based on database type
        switch (dbType) {
            case 'mysql':
                if (!dependencies['mysql2'] && !dependencies['mysql']) {
                    packageToInstall = 'mysql2'
                }
                break
            case 'postgres':
                if (!dependencies['pg']) {
                    packageToInstall = 'pg'
                }
                break
        }

        // Install the required package if missing
        if (packageToInstall) {
            this.log(`Installing required database driver: ${packageToInstall}`)
            try {
                execSync(`npm install ${packageToInstall}`, {
                    stdio: 'inherit',
                    cwd: process.cwd()
                })
                this.log(`Successfully installed ${packageToInstall}`)
            } catch (error) {
                this.error(`Failed to install ${packageToInstall}: ${(error as Error).message}`)
            }
        } else {
            this.log(`Database driver for ${dbType} is already installed`)
        }
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

        // Generate code
        await this.generateCode()
    }

    private async loadDataset(datasource: string, dataset: string): Promise<void> {
        this.log(`Loading dataset '${dataset}' into datasource '${datasource}'...`)

        // Check if the dataset directory exists using the convention: dataSourceName-datasetName
        const datasetPath = path.join(process.cwd(), 'src', 'datasets', `${datasource}-${dataset}`)
        if (!await fs.pathExists(datasetPath)) {
            this.error(`Dataset not found at: ${datasetPath}`)
        }

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
        const dsConfig = dsModule[`${datasource}`] as TypeORMSqlDataSource

        if (!dsConfig) {
            this.error(`Could not find datasource instance ${datasource} in ${dsModulePath}`)
        }

        // Validate Docker is running and PostgreSQL container is available
        await this.validateDockerInfrastructure(datasource)

        // Ensure the required database dependencies are installed
        await this.ensureDatabaseDependencies(datasource)

        // Initialize the datasource with its configuration
        try {
            this.log(`Attempting to connect to database: ${JSON.stringify(dsConfig.getOptions(), null, 2)}`)
            await dsConfig.initialize()
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

        // Process each load result using TypeORM repositories (database-agnostic)
        try {
            // Use the new generic loader method
            await loader.loadDatasetToDatabase(loadResults, dsConfig, true)

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
