import { faker } from '@faker-js/faker'
import { ModelMetadata, FieldMetadata } from './model-analyzer.js'

export interface DataGenerationOptions {
    count?: number
    locale?: string
    seed?: number
    relationships?: boolean
    verbose?: boolean
}

export interface GeneratedRecord {
    [key: string]: any
}

export interface DatasetGenerationResult {
    modelName: string
    records: GeneratedRecord[]
    filePath: string
}

export class SyntheticDataGenerator {
    private options: Required<DataGenerationOptions>

    constructor(options: DataGenerationOptions = {}) {
        this.options = {
            count: options.count || 10,
            locale: options.locale || 'en',
            seed: options.seed || Math.floor(Math.random() * 1000),
            relationships: options.relationships || false,
            verbose: options.verbose || false
        }

        // Set faker seed for consistent results
        faker.seed(this.options.seed)
    }

    /**
     * Generate synthetic datasets for multiple models
     */
    async generateDatasets(models: ModelMetadata[], outputDir: string, datasetName: string): Promise<DatasetGenerationResult[]> {
        const results: DatasetGenerationResult[] = []

        if (this.options.verbose) {
            console.log(`🎯 Generating ${this.options.count} records for each of ${models.length} models`)
        }

        // Sort models by dependencies (models with relationships should come after their dependencies)
        const sortedModels = this.sortModelsByDependencies(models)

        for (const model of sortedModels) {
            if (this.options.verbose) {
                console.log(`📝 Generating data for ${model.name}...`)
            }

            const records = await this.generateRecordsForModel(model, models)
            const filePath = `${outputDir}/${model.dataSource}-${datasetName}/${model.name}.jsonl`

            results.push({
                modelName: model.name,
                records,
                filePath
            })

            if (this.options.verbose) {
                console.log(`✅ Generated ${records.length} records for ${model.name}`)
            }
        }

        return results
    }

    /**
     * Generate records for a single model using Faker
     */
    private async generateRecordsForModel(model: ModelMetadata, allModels: ModelMetadata[]): Promise<GeneratedRecord[]> {
        // Use Faker to generate realistic data
        const records = this.generateRecordsWithFaker(model)
        return records
    }



    /**
     * Generate records using Faker
     */
    private generateRecordsWithFaker(model: ModelMetadata): GeneratedRecord[] {
        const records: GeneratedRecord[] = []

        for (let i = 0; i < this.options.count; i++) {
            const record: GeneratedRecord = {}

            for (const field of model.fields) {
                // Skip fields that are not available or are auto-generated
                if (field.available === false || (field.primaryKey && field.generated)) {
                    continue
                }

                record[field.name] = this.generateFieldValue(field, model)
            }

            records.push(record)
        }

        return records
    }

    /**
     * Generate a value for a specific field using Faker
     */
    private generateFieldValue(field: FieldMetadata, model: ModelMetadata): any {
        // Handle required field logic
        const isRequired = this.evaluateRequired(field, model)

        // Handle availability logic
        const isAvailable = this.evaluateAvailable(field, model)

        if (!isAvailable) {
            return undefined
        }

        // Generate null values for non-required fields sometimes
        if (!isRequired && Math.random() < 0.2) {
            return null
        }

        // Handle composition types
        if (field.type.startsWith('composition:')) {
            const compositionType = field.type.replace('composition:', '')
            return this.generateCompositionValue(compositionType)
        }

        switch (field.type.toLowerCase()) {
            case 'uuid':
                return field.generated ? undefined : faker.string.uuid()

            case 'text':
                return this.generateTextValue(field)

            case 'email':
                return faker.internet.email()

            case 'integer':
                return this.generateIntegerValue(field)

            case 'float':
            case 'decimal':
                return this.generateFloatValue(field)

            case 'boolean':
                return faker.datatype.boolean()

            case 'date':
                return faker.date.past().toISOString()

            case 'html':
                return `<p>${faker.lorem.sentence()}</p>`

            default:
                return faker.lorem.word()
        }
    }

    /**
     * Generate a composition value (embedded object)
     */
    private generateCompositionValue(compositionType: string): any {
        // For now, generate a simple Person-like object for CEO composition
        if (compositionType === 'Person') {
            return {
                firstName: faker.person.firstName(),
                lastName: faker.person.lastName(),
                email: faker.internet.email(),
                age: faker.number.int({ min: 25, max: 65 }), // CEO age range
                phoneNumber: faker.phone.number(),
                additionalInfo: `<p>${faker.person.jobTitle()}</p>`,
                isActive: true
            }
        }

        // Generic composition fallback
        return {
            name: faker.lorem.words(2),
            value: faker.lorem.word()
        }
    }

    /**
     * Generate text value respecting constraints
     */
    private generateTextValue(field: FieldMetadata): string {
        let text: string

        // Generate based on field name hints
        const fieldName = field.name.toLowerCase()
        if (fieldName.includes('name')) {
            if (fieldName.includes('first')) {
                text = faker.person.firstName()
            } else if (fieldName.includes('last')) {
                text = faker.person.lastName()
            } else if (fieldName.includes('company')) {
                text = faker.company.name()
            } else {
                text = faker.person.fullName()
            }
        } else if (fieldName.includes('phone')) {
            text = faker.phone.number()
        } else if (fieldName.includes('address')) {
            text = faker.location.streetAddress()
        } else if (fieldName.includes('city')) {
            text = faker.location.city()
        } else if (fieldName.includes('country')) {
            text = faker.location.country()
        } else {
            text = faker.lorem.words(Math.floor(Math.random() * 3) + 1)
        }

        // Apply length constraints
        if (field.minLength || field.maxLength) {
            const minLen = field.minLength || 1
            const maxLen = field.maxLength || 100

            if (text.length < minLen) {
                text = text.padEnd(minLen, 'x')
            } else if (text.length > maxLen) {
                text = text.substring(0, maxLen)
            }
        }

        // Apply regex constraints (basic validation)
        if (field.regex) {
            try {
                const regex = new RegExp(field.regex)
                if (!regex.test(text)) {
                    // Simple fallback for common patterns
                    if (field.regex.includes('[a-zA-Z]')) {
                        text = faker.lorem.word().substring(0, field.maxLength || 10)
                    }
                }
            } catch (error) {
                // Ignore regex parsing errors
            }
        }

        return text
    }

    /**
     * Generate integer value respecting constraints
     */
    private generateIntegerValue(field: FieldMetadata): number {
        const min = field.min || 0
        const max = field.max || 100

        // Special handling for age field
        if (field.name.toLowerCase().includes('age')) {
            return faker.number.int({ min: 1, max: 120 })
        }

        return faker.number.int({ min, max })
    }

    /**
     * Generate float value respecting constraints
     */
    private generateFloatValue(field: FieldMetadata): number {
        const min = field.min || 0
        const max = field.max || 1000
        const precision = field.precision || 10
        const scale = field.scale || 2

        const value = faker.number.float({ min, max, precision: Math.pow(10, -scale) })
        return parseFloat(value.toFixed(scale))
    }

    /**
     * Evaluate required field condition
     */
    private evaluateRequired(field: FieldMetadata, model: ModelMetadata): boolean {
        if (typeof field.required === 'boolean') {
            return field.required
        }

        if (typeof field.required === 'string') {
            // Simple evaluation for age-based requirements
            if (field.required.includes('age < 18')) {
                // This is a simplification - in real implementation you'd parse the function
                return Math.random() < 0.3 // 30% chance of being under 18
            }
        }

        return false
    }

    /**
     * Evaluate available field condition
     */
    private evaluateAvailable(field: FieldMetadata, model: ModelMetadata): boolean {
        if (field.available === false) {
            return false
        }

        if (typeof field.available === 'boolean') {
            return field.available
        }

        if (typeof field.available === 'string') {
            // Simple evaluation for age-based availability
            if (field.available.includes('age >= 18')) {
                return Math.random() < 0.7 // 70% chance of being 18 or older
            }
        }

        return true
    }

    /**
     * Sort models by dependencies to handle relationships properly
     */
    private sortModelsByDependencies(models: ModelMetadata[]): ModelMetadata[] {
        // For now, just return models as-is
        // In the future, we could analyze relationships and sort accordingly
        return models
    }
}