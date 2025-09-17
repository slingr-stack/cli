import fs from 'fs-extra'
import path from 'node:path'
import { BaseModel, TypeORMSqlDataSource } from 'slingr-framework'

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
     * Load dataset into database using TypeORM with dynamic table creation
     * This method creates tables dynamically and uses TypeORM for data insertion
     */
    async loadDatasetToDatabase(
        results: DatasetLoadResult[],
        dataSource: TypeORMSqlDataSource,
        verbose: boolean = false
    ): Promise<void> {
        const typeormDataSource = dataSource.getTypeORMDataSource()

        if (!typeormDataSource || !typeormDataSource.isInitialized) {
            throw new Error('TypeORM DataSource is not initialized')
        }

        for (const result of results) {
            if (result.errorCount > 0 && verbose) {
                console.log(`⚠️  Model ${result.modelName} has ${result.errorCount} validation errors:`)
                for (const error of result.errors) {
                    console.log(`   Record ${error.recordIndex + 1}: ${JSON.stringify(error.validationErrors)}`)
                }
            }

            if (result.successCount === 0) {
                if (verbose) {
                    console.log(`⚠️  No valid records found for ${result.modelName}, skipping.`)
                }
                continue
            }

            if (verbose) {
                console.log(`📊 Processing ${result.modelName}: ${result.successCount} valid records`)
            }

            try {
                // Convert model instances to database format
                const dbRecords = this.convertToDbFormat(result.records, verbose)

                if (dbRecords.length === 0) {
                    continue
                }

                // Infer database schema from ALL records to capture all fields
                const schema = this.inferDbSchemaFromAllRecords(dbRecords)
                const tableName = result.modelName.toLowerCase()

                // Create table dynamically using TypeORM query runner
                await this.createTableDynamically(dataSource, tableName, schema, verbose)

                // Insert data using TypeORM query runner (database-agnostic)
                await this.insertDataDynamically(dataSource, tableName, dbRecords, verbose)

                if (verbose) {
                    console.log(`✅ Successfully loaded ${result.successCount} records for ${result.modelName}`)

                    // Verify the data was saved
                    const count = await typeormDataSource.query(`SELECT COUNT(*) as count FROM ${tableName}`)
                    console.log(`✅ Verified: Table "${tableName}" contains ${count[0].count} records`)
                }

            } catch (error) {
                console.error(`❌ Failed to load ${result.modelName}:`, error)
                throw error
            }
        }
    }

    /**
     * Create table dynamically using TypeORM (database-agnostic)
     */
    private async createTableDynamically(
        dataSource: TypeORMSqlDataSource,
        tableName: string,
        schema: Record<string, string>,
        verbose: boolean = false
    ): Promise<void> {
        const typeormDataSource = dataSource.getTypeORMDataSource()
        const queryRunner = typeormDataSource.createQueryRunner()

        try {
            // Drop table if exists
            await queryRunner.dropTable(tableName, true)

            // Create new table with proper schema
            const columns = Object.entries(schema).map(([columnName, sqlType]) => {
                let typeormType: string
                let isPrimary = columnName === 'id'

                switch (sqlType) {
                    case 'INTEGER':
                        typeormType = isPrimary ? 'int' : 'int'
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

                return {
                    name: columnName,
                    type: typeormType as any,
                    isPrimary,
                    isNullable: !isPrimary,
                    ...(typeormType === 'varchar' && { length: '500' })
                }
            })

            const table = new (require('typeorm')).Table({
                name: tableName,
                columns
            })

            await queryRunner.createTable(table)

            if (verbose) {
                console.log(`✅ Created table "${tableName}" with ${columns.length} columns`)
            }

        } finally {
            await queryRunner.release()
        }
    }

    /**
     * Insert data dynamically using TypeORM (database-agnostic)
     */
    private async insertDataDynamically(
        dataSource: TypeORMSqlDataSource,
        tableName: string,
        records: any[],
        verbose: boolean = false
    ): Promise<void> {
        if (records.length === 0) return

        const typeormDataSource = dataSource.getTypeORMDataSource()
        const queryRunner = typeormDataSource.createQueryRunner()

        try {
            // Use TypeORM's query builder for database-agnostic insertion
            const columns = Object.keys(records[0])

            for (const record of records) {
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into(tableName)
                    .values(record)
                    .execute()
            }

            if (verbose) {
                console.log(`✅ Inserted ${records.length} records into "${tableName}"`)
            }

        } finally {
            await queryRunner.release()
        }
    }

    /**
     * Get the database column schema based on ALL records to capture all possible fields
     */
    inferDbSchemaFromAllRecords(records: any[]): Record<string, string> {
        const schema: Record<string, string> = {}

        // Examine all records to find all possible fields
        for (const record of records) {
            for (const [key, value] of Object.entries(record)) {
                if (schema[key]) {
                    // Field already exists, keep the existing type or upgrade if needed
                    continue
                }

                let sqlType = 'TEXT'

                if (typeof value === 'number') {
                    sqlType = Number.isInteger(value) ? 'INTEGER' : 'REAL'
                } else if (typeof value === 'boolean') {
                    sqlType = 'BOOLEAN'
                }

                schema[key] = sqlType
            }
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
