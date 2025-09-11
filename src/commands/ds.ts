import { Args, Command } from '@oclif/core'
import fs from 'fs-extra'
import path from 'node:path'
import { TypeORMSqlDataSource } from 'slingr-framework'
import { DataSource, DataSourceOptions } from 'typeorm'

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

        // Initialize the datasource with its configuration
        const dataSource = await dsConfig.initialize(dsConfig.getOptions())

        try {
            // Process each JSONL file
            for (const file of jsonlFiles) {
                const modelName = path.basename(file, '.jsonl')
                this.log(`Loading data for model: ${modelName}`)

                // Read and parse the JSONL file
                const filePath = path.join(datasetPath, file)
                const content = await fs.readFile(filePath, 'utf8')
                const records = content.split('\n')
                    .filter(line => line.trim())
                    .map(line => JSON.parse(line))

                // Get the repository for this model from the DataSource
                const repository = (dataSource as DataSource).getRepository(modelName)

                // Clear existing data
                await repository.clear()

                // Insert the records
                await repository.insert(records)

                this.log(`Successfully loaded ${records.length} records for ${modelName}`)
            }

            this.log(`\nSuccessfully loaded dataset '${dataset}' into datasource '${datasource}'`)

        } finally {
            // Always clean up by closing the datasource connection
            await (dataSource as DataSource).destroy()
        }
    }
}
