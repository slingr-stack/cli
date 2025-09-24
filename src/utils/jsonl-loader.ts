import fs from 'fs-extra'
import path from 'node:path'
import { BaseModel, TypeORMSqlDataSource } from 'slingr-framework'
import 'reflect-metadata'

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
 * Interface for model dependency information
 */
export interface ModelDependency {
    modelName: string
    dependencies: string[]
    dependents: string[]
}

/**
 * Interface for dependency analysis result
 */
export interface DependencyAnalysisResult {
    dependencies: Record<string, ModelDependency>
    loadOrder: string[]
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
     * Analyze model dependencies to determine the correct loading order
     */
    analyzeDependencies(modelMap: Record<string, ModelConstructor<any>>, verbose: boolean = false): DependencyAnalysisResult {
        const dependencies: Record<string, ModelDependency> = {}

        // Initialize dependency tracking for all models
        for (const modelName of Object.keys(modelMap)) {
            dependencies[modelName] = {
                modelName,
                dependencies: [],
                dependents: []
            }
        }

        // Analyze each model for dependencies
        for (const [modelName, ModelClass] of Object.entries(modelMap)) {
            const modelDeps = this.extractModelDependencies(ModelClass, verbose)
            dependencies[modelName].dependencies = modelDeps

            // Update dependents for referenced models
            for (const depName of modelDeps) {
                if (dependencies[depName]) {
                    dependencies[depName].dependents.push(modelName)
                }
            }
        }

        // Determine load order using topological sort
        const loadOrder = this.topologicalSort(dependencies, verbose)

        if (verbose) {
            console.log('📋 Dependency Analysis:')
            for (const [modelName, deps] of Object.entries(dependencies)) {
                console.log(`  ${modelName}: depends on [${deps.dependencies.join(', ')}], depended by [${deps.dependents.join(', ')}]`)
            }
            console.log(`🔄 Load Order: ${loadOrder.join(' → ')}`)
        }

        return { dependencies, loadOrder }
    }

    /**
     * Extract dependencies from a model class by analyzing its decorators/metadata
     */
    private extractModelDependencies(ModelClass: ModelConstructor<any>, verbose: boolean = false): string[] {
        const dependencies: string[] = []

        if (verbose) {
            console.log(`    🔍 Analyzing ${ModelClass.name} for dependencies...`)
        }

        try {
            // Create a temporary instance to access metadata
            const instance = new ModelClass()

            // Get all property descriptors from the prototype and instance
            const proto = Object.getPrototypeOf(instance)
            const propertyNames = Object.getOwnPropertyNames(proto).concat(Object.getOwnPropertyNames(instance))

            if (verbose) {
                console.log(`    Properties found:`, propertyNames.filter(p => p !== 'constructor'))
            }

            for (const propertyName of propertyNames) {
                if (propertyName === 'constructor') continue

                try {
                    // Try to get all available metadata keys first
                    const availableKeys = Reflect.getMetadataKeys?.(instance, propertyName) || []

                    if (verbose && availableKeys.length > 0) {
                        console.log(`    Metadata keys for ${propertyName}:`, availableKeys)
                    }

                    // Try to get Slingr-specific metadata using the correct keys
                    const fieldType = Reflect.getMetadata?.('field:type', instance, propertyName)
                    const relationshipType = Reflect.getMetadata?.('field:relationship:type', instance, propertyName)
                    const designType = Reflect.getMetadata?.('design:type', instance, propertyName)

                    if (verbose && (fieldType || relationshipType)) {
                        console.log(`    Property ${propertyName}:`, {
                            fieldType,
                            relationshipType,
                            designType: designType?.name
                        })
                    }

                    // Check for Reference and Composition relationships
                    if (fieldType === 'relationship' && relationshipType && designType) {
                        // For relationships, designType contains the name of the referenced model
                        if (typeof designType === 'string') {
                            dependencies.push(designType)
                            if (verbose) {
                                console.log(`    ✅ Found dependency: ${ModelClass.name}.${propertyName} → ${designType} (${relationshipType})`)
                            }
                        } else if (typeof designType === 'function' && designType.name) {
                            dependencies.push(designType.name)
                            if (verbose) {
                                console.log(`    ✅ Found dependency: ${ModelClass.name}.${propertyName} → ${designType.name} (${relationshipType})`)
                            }
                        }
                    }

                    // Also check property getter/setter for reference information
                    const descriptor = Object.getOwnPropertyDescriptor(instance, propertyName) ||
                        Object.getOwnPropertyDescriptor(proto, propertyName)

                    if (descriptor) {
                        // Check if the property has reference metadata
                        const refMetadata = Reflect.getMetadata?.('slingr:reference', instance, propertyName)
                        if (refMetadata && refMetadata.elementType) {
                            const referencedType = refMetadata.elementType()
                            if (referencedType && referencedType.name) {
                                dependencies.push(referencedType.name)
                                if (verbose) {
                                    console.log(`    Found reference dependency: ${ModelClass.name}.${propertyName} → ${referencedType.name}`)
                                }
                            }
                        }

                        // Check composition metadata
                        const compMetadata = Reflect.getMetadata?.('slingr:composition', instance, propertyName)
                        if (compMetadata && compMetadata.elementType) {
                            const composedType = compMetadata.elementType()
                            if (composedType && composedType.name) {
                                dependencies.push(composedType.name)
                                if (verbose) {
                                    console.log(`    Found composition dependency: ${ModelClass.name}.${propertyName} → ${composedType.name}`)
                                }
                            }
                        }
                    }
                } catch (error) {
                    // Ignore property analysis errors, continue with next property
                    if (verbose) {
                        console.log(`    Skipped property ${propertyName} due to error:`, (error as Error).message)
                    }
                }
            }
        } catch (error) {
            if (verbose) {
                console.warn(`Failed to analyze dependencies for ${ModelClass.name}:`, (error as Error).message)
            }
        }

        // Remove duplicates and self-references
        return Array.from(new Set(dependencies)).filter(dep => dep !== ModelClass.name)
    }

    /**
     * Perform topological sort to determine loading order
     */
    private topologicalSort(dependencies: Record<string, ModelDependency>, verbose: boolean = false): string[] {
        const visited = new Set<string>()
        const visiting = new Set<string>()
        const result: string[] = []

        const visit = (modelName: string): void => {
            if (visiting.has(modelName)) {
                throw new Error(`Circular dependency detected involving: ${modelName}`)
            }

            if (visited.has(modelName)) {
                return
            }

            visiting.add(modelName)

            // Visit all dependencies first
            const modelDeps = dependencies[modelName]?.dependencies || []
            for (const depName of modelDeps) {
                if (dependencies[depName]) {
                    visit(depName)
                }
            }

            visiting.delete(modelName)
            visited.add(modelName)
            result.push(modelName)
        }

        // Visit all models
        for (const modelName of Object.keys(dependencies)) {
            if (!visited.has(modelName)) {
                visit(modelName)
            }
        }

        return result
    }

    /**
     * Load all JSONL files from a dataset directory
     */
    async loadDataset(options: DatasetLoadOptions): Promise<DatasetLoadResult[]> {
        const { datasetPath, modelMap, validateRecords = true, verbose = false } = options

        if (!await fs.pathExists(datasetPath)) {
            throw new Error(`Dataset directory not found: ${datasetPath}`)
        }

        // Analyze dependencies first to determine correct loading order
        const dependencyAnalysis = this.analyzeDependencies(modelMap, verbose)

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
        const loadedEntities: Record<string, Record<string, any>> = {}

        // Process files in dependency order instead of arbitrary order
        for (const modelName of dependencyAnalysis.loadOrder) {
            const fileName = `${modelName}.jsonl`

            if (!jsonlFiles.includes(fileName)) {
                if (verbose) {
                    console.log(`📄 No JSONL file found for model: ${modelName} (expected: ${fileName}). Skipping...`)
                }
                continue
            }

            const ModelClass = modelMap[modelName]
            if (!ModelClass) {
                if (verbose) {
                    console.warn(`No model mapping found for: ${modelName}. Skipping...`)
                }
                continue
            }

            const filePath = path.join(datasetPath, fileName)
            const result = await this.loadJsonlFile(filePath, ModelClass, modelName, loadedEntities, validateRecords, verbose)

            // Store successfully loaded entities for future reference resolution
            if (result.records.length > 0) {
                loadedEntities[modelName] = {}
                for (const record of result.records) {
                    const id = (record as any).id
                    if (id) {
                        loadedEntities[modelName][id] = record
                    }
                }
            }

            results.push(result)
        }

        return results
    }

    /**
     * Load a single JSONL file and convert records using the model's fromJSON method
     */
    /**
     * Resolves simple references in format {"id": "uuid"} to full objects from loaded entities
     */
    async resolveSimpleReferences<T extends BaseModel>(
        data: any,
        ModelClass: ModelConstructor<T>,
        loadedEntities: Record<string, Record<string, any>>,
        verbose: boolean = false
    ): Promise<any> {
        if (!data || typeof data !== 'object') {
            return data;
        }

        const resolvedData = { ...data };
        const metadata = Reflect.getMetadata('custom:fields', ModelClass.prototype) || {};

        // Get relationship metadata using the correct keys
        for (const fieldName of Object.keys(resolvedData)) {
            const fieldType = Reflect.getMetadata('field:type', ModelClass.prototype, fieldName);
            const relationshipType = Reflect.getMetadata('field:relationship:type', ModelClass.prototype, fieldName);
            const designType = Reflect.getMetadata('design:type', ModelClass.prototype, fieldName);

            // If it's a reference/composition and has simple format {"id": "uuid"}
            if ((fieldType === 'reference' || fieldType === 'composition' || relationshipType) &&
                resolvedData[fieldName] &&
                typeof resolvedData[fieldName] === 'object' &&
                resolvedData[fieldName].id &&
                Object.keys(resolvedData[fieldName]).length === 1) {

                const refId = resolvedData[fieldName].id;

                // Determine the referenced model type from metadata
                let refModelName: string | null = null;

                // Try to get the model name from designType
                if (designType && designType.name) {
                    refModelName = designType.name;
                } else if (designType && typeof designType === 'function') {
                    refModelName = designType.name;
                } else {
                    // Fallback: search in all available metadata keys
                    const allMetadataKeys = Reflect.getMetadataKeys?.(ModelClass.prototype, fieldName) || [];

                    for (const key of allMetadataKeys) {
                        const value = Reflect.getMetadata(key, ModelClass.prototype, fieldName);

                        // Search for referenced type information in any metadata
                        if (value && typeof value === 'object') {
                            if (value.type && typeof value.type === 'function' && value.type.name) {
                                refModelName = value.type.name;
                                break;
                            } else if (value.target && typeof value.target === 'function' && value.target.name) {
                                refModelName = value.target.name;
                                break;
                            } else if (value.elementType && typeof value.elementType === 'function') {
                                const elementType = value.elementType();
                                if (elementType && elementType.name) {
                                    refModelName = elementType.name;
                                    break;
                                }
                            }
                        } else if (typeof value === 'function' && value.name) {
                            refModelName = value.name;
                            break;
                        }
                    }

                    if (verbose && !refModelName && allMetadataKeys.length > 0) {
                        console.log(`    Could not determine reference type for ${fieldName}, available metadata:`,
                            allMetadataKeys.map(key => ({ key, value: Reflect.getMetadata(key, ModelClass.prototype, fieldName) })));
                    }
                }

                // Search for the complete object in loadedEntities
                if (refModelName && loadedEntities[refModelName] && loadedEntities[refModelName][refId]) {
                    resolvedData[fieldName] = loadedEntities[refModelName][refId];
                    if (verbose) {
                        console.log(`    Resolved ${fieldName}.id=${refId} → ${refModelName} object`);
                    }
                } else if (verbose && refModelName) {
                    console.log(`    Warning: Could not resolve ${fieldName}.id=${refId} (${refModelName} not found)`);
                }
            }
        }

        return resolvedData;
    }

    async loadJsonlFile<T extends BaseModel>(
        filePath: string,
        ModelClass: ModelConstructor<T>,
        modelName: string,
        loadedEntities: Record<string, Record<string, any>>,
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

                // Resolve simple references before creating the model instance
                const resolvedData = await this.resolveSimpleReferences(rawData, ModelClass, loadedEntities, verbose)

                // Use the model's fromJSON method to create the instance
                const modelInstance = ModelClass.fromJSON(resolvedData)

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
     * Note: Results should already be in dependency order from loadDataset()
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

        // Process results in the order they were provided (which should be dependency order)
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
                // Save records using the framework's save method which respects relationships
                for (const record of result.records) {
                    await dataSource.save(record)
                }

                if (verbose) {
                    console.log(`✅ Successfully loaded ${result.successCount} records for ${result.modelName}`)
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
        .then((files: string[]) => files.filter((file: string) => !file.includes('.test.js')))

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
