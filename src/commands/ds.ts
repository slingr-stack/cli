import { Args, Command, Flags } from '@oclif/core'
import fs from 'fs-extra'
import path from 'node:path'
import { execSync } from 'child_process'
import { TypeORMSqlDataSource } from 'slingr-framework'
import { JsonlDatasetLoader, discoverModels } from '../utils/jsonl-loader.js'
import { ModelAnalyzer, ModelMetadata } from '../utils/model-analyzer.js'
import { SyntheticDataGenerator, DataGenerationOptions, DatasetGenerationResult } from '../utils/synthetic-data-generator.js'

export default class Ds extends Command {
    static description = 'Manage datasets for datasources'

    static examples = [
        'slingr ds postgres load',
        'slingr ds postgres load custom-dataset',
        'slingr ds mysql load default',
        'slingr ds postgres generate-dataset synthetic',
        'slingr ds postgres generate-dataset --count 100 --generate-prompt',
        'slingr ds mysql generate-dataset custom --count 50'
    ]

    static args = {
        datasource: Args.string({
            description: 'Name of the datasource to manage',
            required: true
        }),
        action: Args.string({
            description: 'Action to perform (load, generate-dataset)',
            options: ['load', 'generate-dataset'],
            required: true
        }),
        dataset: Args.string({
            description: 'Name of the dataset to load/generate (defaults to "default")',
            required: false,
            default: 'default'
        })
    }

    static flags = {
        count: Flags.integer({
            char: 'c',
            description: 'Number of records to generate per model',
            default: 10,
            min: 1,
            max: 10000
        }),
        locale: Flags.string({
            description: 'Locale for fake data generation',
            default: 'en'
        }),
        seed: Flags.integer({
            description: 'Seed for reproducible fake data generation'
        }),
        verbose: Flags.boolean({
            char: 'v',
            description: 'Verbose output'
        }),
        'generate-prompt': Flags.boolean({
            description: 'Generate AI analysis prompt and save to file/clipboard',
            default: false
        })
    }

    async run(): Promise<void> {
        const { args, flags } = await this.parse(Ds)
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
                case 'generate-dataset':
                    await this.generateDataset(datasource, dataset, flags)
                    break
                default:
                    this.error(`Unknown action: ${action}`)
            }
        } catch (error) {
            this.error(`Failed to ${action} dataset: ${(error as Error).message}`)
        }
    }

    /**
     * Generate synthetic dataset using Faker
     */
    private async generateDataset(datasource: string, dataset: string, flags: any): Promise<void> {
        this.log(`🎯 Generating synthetic dataset '${dataset}' for datasource '${datasource}'...`)

        // Ensure we have compiled TypeScript code to analyze
        await this.prepareEnvironment()

        // Analyze models from the source code
        const analyzer = new ModelAnalyzer()
        const srcPath = path.join(process.cwd(), 'src')

        try {
            const allModels = await analyzer.analyzeModels(srcPath)

            if (allModels.length === 0) {
                this.error('No models found to generate data for. Please ensure you have models in src/data/ that extend BaseModel.')
            }

            // Filter models by datasource
            const modelsForDataSource = allModels.filter(model =>
                model.dataSource === `${datasource}DataSource` ||
                model.dataSource === datasource
            )

            if (modelsForDataSource.length === 0) {
                this.error(`No models found for datasource '${datasource}'. Available datasources: ${[...new Set(allModels.map(m => m.dataSource))].join(', ')}`)
            }

            this.log(`📊 Found ${modelsForDataSource.length} models for datasource '${datasource}':`)
            modelsForDataSource.forEach(model => {
                this.log(`   - ${model.name} (${model.fields.length} fields)`)
            })

            // Set up data generation options (only Faker)
            const options: DataGenerationOptions = {
                count: flags.count,
                locale: flags.locale,
                seed: flags.seed,
                verbose: flags.verbose
            }

            // Create synthetic data generator
            const generator = new SyntheticDataGenerator(options)

            // Generate datasets
            const outputDir = path.join(process.cwd(), 'src', 'datasets')
            const results = await generator.generateDatasets(modelsForDataSource, outputDir, dataset)

            // Create output directory if it doesn't exist
            const datasetOutputDir = path.join(outputDir, `${datasource}-${dataset}`)
            await fs.ensureDir(datasetOutputDir)

            // Write JSONL files
            for (const result of results) {
                const filePath = path.join(datasetOutputDir, `${result.modelName}.jsonl`)

                // Convert records to JSONL format
                const jsonlContent = result.records.map(record => JSON.stringify(record)).join('\n')

                await fs.writeFile(filePath, jsonlContent, 'utf-8')

                if (flags.verbose) {
                    this.log(`💾 Wrote ${result.records.length} records to ${filePath}`)
                }
            }

            // Summary
            const totalRecords = results.reduce((sum, r) => sum + r.records.length, 0)
            this.log(`\n🎉 Successfully generated synthetic dataset '${dataset}' for datasource '${datasource}'`)
            this.log(`📈 Summary:`)
            this.log(`   - ${results.length} model(s) processed`)
            this.log(`   - ${totalRecords} total records generated`)
            this.log(`   - Output directory: ${datasetOutputDir}`)
            this.log(`\n💡 To load this dataset, run:`)
            this.log(`   slingr ds ${datasource} load ${dataset}`)

            // Generate AI prompt if requested
            if (flags['generate-prompt']) {
                const prompt = await this.generateProjectAnalysisPrompt(modelsForDataSource, results, datasource, dataset, flags.verbose)

                this.log(`\n🤖 Generated AI Analysis Prompt:`)
                this.log(`\n${'='.repeat(80)}`)
                this.log(prompt)
                this.log(`${'='.repeat(80)}`)

                // Save file and copy to clipboard
                await this.openCopilotWithPrompt(prompt)
            }

        } catch (error) {
            this.error(`Failed to generate synthetic dataset: ${(error as Error).message}`)
        }
    }

    /**
     * Generate an intelligent English prompt for AI analysis based on project descriptions
     */
    private async generateProjectAnalysisPrompt(
        models: ModelMetadata[],
        results: DatasetGenerationResult[],
        datasource: string,
        dataset: string,
        verbose: boolean = false
    ): Promise<string> {
        // Read project documentation
        const projectInfo = await this.extractProjectInfo()

        // Build model descriptions
        const modelDescriptions = models.map(model => {
            const fieldList = model.fields
                .filter(f => f.available !== false && !(f.primaryKey && f.generated))
                .map(f => {
                    let desc = `  - ${f.name} (${f.type})`
                    if (f.required) desc += ' [required]'
                    if (f.minLength || f.maxLength) desc += ` [length: ${f.minLength || 0}-${f.maxLength || 255}]`
                    if (f.min !== undefined || f.max !== undefined) desc += ` [range: ${f.min || 0}-${f.max || 100}]`
                    if (f.regex) desc += ` [pattern: ${f.regex}]`
                    return desc
                })
                .join('\n')

            return `**${model.name}** ${model.docs ? `- ${model.docs}` : ''}
${fieldList}
Generated: ${results.find(r => r.modelName === model.name)?.records.length || 0} records`
        }).join('\n\n')

        // Generate data preview
        const dataPreview = await this.generateDataPreview(results)

        // Load template from external file
        let template = ''

        const possiblePaths = [
            // 1. Try installed package path
            path.join(process.cwd(), 'node_modules', '@slingr', 'cli', 'dist', 'templates', 'prompt-analysis.md.template'),
            path.join(process.cwd(), 'node_modules', '@slingr', 'cli', 'src', 'templates', 'prompt-analysis.md.template'),
            // 2. Try local development paths
            path.join(__dirname, '..', '..', 'src', 'templates', 'prompt-analysis.md.template'),
            path.join(__dirname, '..', 'templates', 'prompt-analysis.md.template'),
        ]

        let templateLoaded = false
        for (const templatePath of possiblePaths) {
            try {
                template = await fs.readFile(templatePath, 'utf-8')
                templateLoaded = true
                if (verbose) {
                    this.log(`📄 Using template: ${templatePath}`)
                }
                break
            } catch (error) {
                // Continue to next path
            }
        }

        if (!templateLoaded) {
            this.error(`Template file not found. Searched in:\n${possiblePaths.map(p => `  - ${p}`).join('\n')}\n\nPlease ensure the CLI is properly installed or the template file exists.`)
        }

        // Calculate variables for template
        const totalRecords = results.reduce((sum, r) => sum + r.records.length, 0)
        const avgRecordsPerModel = Math.ceil(totalRecords / results.length)

        // Replace template variables
        const replacements = {
            '{{PROJECT_NAME}}': projectInfo.name,
            '{{PROJECT_DESCRIPTION}}': projectInfo.description,
            '{{DATASOURCE}}': datasource,
            '{{DATASET}}': dataset,
            '{{TIMESTAMP}}': new Date().toISOString(),
            '{{TOTAL_MODELS}}': models.length.toString(),
            '{{TOTAL_RECORDS}}': totalRecords.toString(),
            '{{DATASET_FILES}}': results.map(r => `- \`${r.modelName}.jsonl\` - ${r.records.length} records`).join('\n'),
            '{{MODEL_DESCRIPTIONS}}': modelDescriptions,
            '{{DATA_PREVIEW}}': dataPreview,
            '{{AVG_RECORDS_PER_MODEL}}': avgRecordsPerModel.toString()
        }

        // Apply all replacements
        for (const [placeholder, value] of Object.entries(replacements)) {
            template = template.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value)
        }

        return template
    }

    /**
     * Generate a preview of the actual generated data for the prompt
     */
    private async generateDataPreview(results: DatasetGenerationResult[]): Promise<string> {
        const previews = await Promise.all(results.map(async result => {
            // Show first 2 records as examples
            const samples = result.records.slice(0, 2)
            const sampleText = samples.map(record =>
                '  ' + JSON.stringify(record, null, 0)
            ).join('\n')

            return `### ${result.modelName} Sample Data
\`\`\`json
${sampleText}
\`\`\`
*Showing 2 of ${result.records.length} generated records*`
        }))

        return previews.join('\n\n')
    }

    /**
     * Extract project information from various sources
     */
    private async extractProjectInfo(): Promise<{ name: string, description: string }> {
        let name = 'Slingr Application'
        let description = 'A Slingr framework application with TypeORM data models.'

        try {
            // Try to read package.json
            const pkgPath = path.join(process.cwd(), 'package.json')
            if (await fs.pathExists(pkgPath)) {
                const pkg = await fs.readJSON(pkgPath)
                name = pkg.name || name
                if (pkg.description) {
                    description = pkg.description
                }
            }

            // Try to read app description from docs
            const docsPath = path.join(process.cwd(), 'docs', 'app-description.md')
            if (await fs.pathExists(docsPath)) {
                const docsContent = await fs.readFile(docsPath, 'utf-8')
                if (docsContent.trim().length > 0) {
                    description += '\n\n' + docsContent.trim()
                }
            }

            // Try to read README
            const readmePath = path.join(process.cwd(), 'README.md')
            if (await fs.pathExists(readmePath)) {
                const readmeContent = await fs.readFile(readmePath, 'utf-8')
                const lines = readmeContent.split('\n').slice(0, 10) // First 10 lines only
                const summary = lines.find(line => line.trim() && !line.startsWith('#'))
                if (summary) {
                    description += '\n\n' + summary.trim()
                }
            }

        } catch (error) {
            // Ignore errors, use defaults
        }

        return { name, description }
    }

    /**
     * Open Copilot Chat with the generated prompt
     */
    private async openCopilotWithPrompt(prompt: string): Promise<void> {
        try {
            // Method 1: Create a temporary markdown file with the prompt and open it
            const tempDir = path.join(process.cwd(), '.temp')
            await fs.ensureDir(tempDir)

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
            const tempFile = path.join(tempDir, `copilot-prompt-${timestamp}.md`)

            const fileContent = `# AI Analysis Prompt - Generated by Slingr CLI

${prompt}

---
*This file was automatically generated. You can copy the content above and paste it into Copilot Chat, or select all text and use "Ask Copilot" from the context menu.*`

            await fs.writeFile(tempFile, fileContent, 'utf-8')

            // Try to open VS Code with the file
            try {
                execSync(`code "${tempFile}"`, { stdio: 'pipe' })
                this.log(`\n💬 Opened prompt in VS Code: ${tempFile}`)
                this.log(`📋 Select all text and use "Ask Copilot" from the context menu, or copy and paste into Copilot Chat`)

                // Try to also trigger the Copilot Chat command
                setTimeout(() => {
                    try {
                        execSync(`code --command workbench.action.chat.open`, { stdio: 'pipe' })
                    } catch {
                        // Ignore if command fails
                    }
                }, 1000)

            } catch (codeError) {
                // Fallback: just show the file path
                this.log(`\n📁 Prompt saved to: ${tempFile}`)
                this.log(`💡 Open this file in VS Code and use "Ask Copilot" to analyze the content`)
            }

            // Method 2: Try to copy to clipboard if possible
            try {
                const { spawn } = require('child_process')
                const platform = process.platform

                let clipboardCommand: string[] = []

                if (platform === 'darwin') {
                    // macOS
                    clipboardCommand = ['pbcopy']
                } else if (platform === 'win32') {
                    // Windows
                    clipboardCommand = ['clip']
                } else if (platform === 'linux') {
                    // Linux (try xclip first, then xsel)
                    try {
                        execSync('which xclip', { stdio: 'pipe' })
                        clipboardCommand = ['xclip', '-selection', 'clipboard']
                    } catch {
                        try {
                            execSync('which xsel', { stdio: 'pipe' })
                            clipboardCommand = ['xsel', '--clipboard', '--input']
                        } catch {
                            throw new Error('No clipboard utility found')
                        }
                    }
                }

                if (clipboardCommand.length > 0) {
                    const clipProcess = spawn(clipboardCommand[0], clipboardCommand.slice(1), {
                        stdio: ['pipe', 'pipe', 'pipe']
                    })

                    clipProcess.stdin.write(prompt)
                    clipProcess.stdin.end()

                    clipProcess.on('close', (code: number | null) => {
                        if (code === 0) {
                            this.log(`📋 Prompt also copied to clipboard! You can paste it directly into Copilot Chat.`)
                        }
                    })
                }
            } catch (clipError) {
                // Clipboard copy failed, but that's ok
            }

        } catch (error) {
            this.log(`⚠️  Could not automatically open Copilot: ${(error as Error).message}`)
            this.log(`💡 Please manually copy the prompt above and paste it into Copilot Chat`)
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
        const dsConfig = dsModule[`${datasource}DataSource`] as TypeORMSqlDataSource

        if (!dsConfig) {
            this.error(`Could not find datasource instance ${datasource}DataSource in ${dsModulePath}`)
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
