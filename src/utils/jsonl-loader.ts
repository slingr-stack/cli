import fs from 'fs-extra'
import path from 'node:path'
import { BaseModel } from 'slingr-framework'

/**
 * Interface for model constructors that extend BaseModel
 */
export interface ModelConstructor<T extends BaseModel> {
    new(): T
    fromJSON(data: any): T
    prototype: T
}

/**
 * Interface for dataset loading options
 */
export interface DatasetLoadOptions {
    /**
     * Directory containing the JSONL files
     */
    datasetPath: string

    /**
     * Map of model name to model constructor
     * Key: filename without .jsonl extension
     * Value: Model constructor class
     */
    modelMap: Record<string, ModelConstructor<any>>

    /**
     * Whether to validate each record after loading from JSON
     * @default true
     */
    validateRecords?: boolean

    /**
     * Whether to log detailed information during loading
     * @default false
     */
    verbose?: boolean
}

/**
 * Result of loading a dataset
 */
export interface DatasetLoadResult<T extends BaseModel = BaseModel> {
    /**
     * Name of the model/file that was loaded
     */
    modelName: string

    /**
     * Array of loaded and converted model instances
     */
    records: T[]

    /**
     * Number of records successfully loaded
     */
    successCount: number

    /**
     * Number of records that failed to load
     */
    errorCount: number

    /**
     * Array of validation errors if any
     */
    errors: Array<{
        recordIndex: number
        recordData: any
        validationErrors: any[]
    }>
}

/**
 * Utility class for loading datasets from JSONL files using Slingr model fromJSON() functionality
 */
export class JsonlDatasetLoader {

    /**
     * Load all JSONL files from a dataset directory
     */
    async loadDataset(options: DatasetLoadOptions): Promise<DatasetLoadResult[]> {
        const { datasetPath, modelMap, validateRecords = true, verbose = false } = options

        if (!await fs.pathExists(datasetPath)) {
            throw new Error(`Dataset directory not found: ${datasetPath}`)
        }

        // Find all JSONL files in the dataset directory
        const files = await fs.readdir(datasetPath)
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

        if (jsonlFiles.length === 0) {
            throw new Error(`No JSONL files found in dataset directory: ${datasetPath}`)
        }

        if (verbose) {
            console.log(`Found ${jsonlFiles.length} JSONL files to process:`, jsonlFiles)
        }

        const results: DatasetLoadResult[] = []

        for (const file of jsonlFiles) {
            const modelName = path.basename(file, '.jsonl')
            const ModelClass = modelMap[modelName]

            if (!ModelClass) {
                if (verbose) {
                    console.warn(`No model mapping found for file: ${file}. Skipping...`)
                }
                continue
            }

            const filePath = path.join(datasetPath, file)
            const result = await this.loadJsonlFile(filePath, ModelClass, modelName, validateRecords, verbose)
            results.push(result)
        }

        return results
    }

    /**
     * Load a single JSONL file and convert records using the model's fromJSON method
     */
    async loadJsonlFile<T extends BaseModel>(
        filePath: string,
        ModelClass: ModelConstructor<T>,
        modelName: string,
        validateRecords: boolean = true,
        verbose: boolean = false
    ): Promise<DatasetLoadResult<T>> {

        if (verbose) {
            console.log(`Loading JSONL file: ${filePath} for model: ${modelName}`)
        }

        const content = await fs.readFile(filePath, 'utf8')
        const lines = content.split('\n').filter(line => line.trim())

        const result: DatasetLoadResult<T> = {
            modelName,
            records: [],
            successCount: 0,
            errorCount: 0,
            errors: []
        }

        for (let i = 0; i < lines.length; i++) {
            try {
                const rawData = JSON.parse(lines[i])

                if (verbose) {
                    console.log(`Processing record ${i + 1}:`, rawData)
                }

                // Use the model's fromJSON method to create the instance
                const modelInstance = ModelClass.fromJSON(rawData)

                // Validate the instance if requested
                if (validateRecords) {
                    const validationErrors = await modelInstance.validate()

                    if (validationErrors && validationErrors.length > 0) {
                        result.errors.push({
                            recordIndex: i,
                            recordData: rawData,
                            validationErrors
                        })
                        result.errorCount++

                        if (verbose) {
                            console.warn(`Validation failed for record ${i + 1}:`, validationErrors)
                        }

                        continue // Skip this record
                    }
                }

                result.records.push(modelInstance)
                result.successCount++

                if (verbose) {
                    console.log(`Successfully loaded record ${i + 1}`)
                }

            } catch (error) {
                result.errorCount++
                result.errors.push({
                    recordIndex: i,
                    recordData: lines[i],
                    validationErrors: [{
                        property: 'parsing',
                        constraints: { parseError: (error as Error).message }
                    }]
                })

                if (verbose) {
                    console.error(`Failed to parse record ${i + 1}:`, error)
                }
            }
        }

        if (verbose) {
            console.log(`Completed loading ${modelName}: ${result.successCount} success, ${result.errorCount} errors`)
        }

        return result
    }

    /**
     * Convert loaded model instances to database-friendly format
     * This method respects the model's field availability settings and converts camelCase to snake_case
     */
    convertToDbFormat<T extends BaseModel>(records: T[], verbose: boolean = false): any[] {
        return records.map(record => {
            // Use the model's toJSON method to get the proper serialization
            const jsonData = record.toJSON()

            // Convert camelCase to snake_case for database column names
            const dbRecord: any = {}

            // Ensure id is always included if it exists in the original data
            if ((record as any).id !== undefined) {
                dbRecord.id = (record as any).id
            }

            for (const [key, value] of Object.entries(jsonData)) {
                const snakeCaseKey = this.camelToSnakeCase(key)
                dbRecord[snakeCaseKey] = value
            }

            if (verbose) {
                console.log('Converted record:', jsonData, '→', dbRecord)
            }

            return dbRecord
        })
    }

    /**
     * Convert camelCase string to snake_case
     */
    private camelToSnakeCase(str: string): string {
        return str.replace(/([A-Z])/g, '_$1').toLowerCase()
    }

    /**
     * Get the database column schema based on a sample record
     * This can be used to create database tables dynamically
     */
    inferDbSchema(sampleRecord: any): Record<string, string> {
        const schema: Record<string, string> = {}

        for (const [key, value] of Object.entries(sampleRecord)) {
            let sqlType = 'TEXT'

            if (typeof value === 'number') {
                sqlType = Number.isInteger(value) ? 'INTEGER' : 'REAL'
            } else if (typeof value === 'boolean') {
                sqlType = 'BOOLEAN'
            }

            schema[key] = sqlType
        }

        return schema
    }
}

/**
 * Auto-discover models from the compiled JavaScript files
 */
export async function discoverModels(distPath: string): Promise<Record<string, ModelConstructor<any>>> {
    const modelMap: Record<string, ModelConstructor<any>> = {}

    if (!await fs.pathExists(distPath)) {
        throw new Error(`Dist directory not found: ${distPath}. Please run 'npm run build' first.`)
    }

    // Import glob dynamically since it might be ESM
    const { glob } = await import('glob')

    // Only look for model files, not test files
    const entityFiles = await glob(path.join(distPath, 'data', '**', '*.js').replace(/\\/g, '/'))
        .then(files => files.filter(file => !file.includes('.test.js')))

    for (const file of entityFiles) {
        try {
            // Clear the require cache to ensure fresh loading
            delete require.cache[path.resolve(file)]

            const module = require(path.resolve(file))
            const exports = Object.values(module)

            for (const exp of exports) {
                if (typeof exp === 'function' &&
                    exp.prototype &&
                    exp.name &&
                    typeof (exp as any).fromJSON === 'function') {

                    console.log(`✅ Found model: ${exp.name} in ${file}`)
                    modelMap[exp.name] = exp as ModelConstructor<any>
                }
            }
        } catch (error) {
            console.warn(`Failed to load entity from file: ${file}:`, error)
        }
    }

    return modelMap
}
