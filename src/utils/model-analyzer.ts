import fs from 'fs-extra'
import path from 'node:path'
import { glob } from 'glob'

//TODO: get structures from framework
export interface FieldMetadata {
    name: string
    type: string
    required: boolean | string // can be function as string
    primaryKey?: boolean
    generated?: boolean
    validation?: string // validation function as string
    available?: boolean | string // can be function as string
    minLength?: number
    maxLength?: number
    regex?: string
    regexMessage?: string
    min?: number
    max?: number
    precision?: number
    scale?: number
}

export interface ModelMetadata {
    name: string
    filePath: string
    dataSource: string
    fields: FieldMetadata[]
    relationships: RelationshipMetadata[]
    docs?: string
}

export interface RelationshipMetadata {
    fieldName: string
    type: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany'
    targetModel: string
    cascade?: boolean
    eager?: boolean
}

export class ModelAnalyzer {

    /**
     * Analyze all models in the src directory and extract metadata
     */
    async analyzeModels(srcPath: string): Promise<ModelMetadata[]> {
        const modelFiles = await glob('**/*.ts', {
            cwd: path.join(srcPath, 'data'),
            absolute: true,
            ignore: ['**/*.test.ts', '**/Models.test.ts']
        })

        const models: ModelMetadata[] = []

        for (const filePath of modelFiles) {
            try {
                const modelMetadata = await this.analyzeModel(filePath)
                if (modelMetadata) {
                    models.push(modelMetadata)
                }
            } catch (error) {
                console.warn(`Warning: Could not analyze model ${filePath}: ${(error as Error).message}`)
            }
        }

        return models
    }

    /**
     * Analyze a single TypeScript model file and extract metadata
     */
    async analyzeModel(filePath: string): Promise<ModelMetadata | null> {
        const content = await fs.readFile(filePath, 'utf-8')

        // Extract model class name
        const classMatch = content.match(/export\s+class\s+(\w+)\s+extends\s+BaseModel/)
        if (!classMatch) {
            return null // Not a model file
        }

        const modelName = classMatch[1]

        // Extract model decorator info
        const modelDecoratorMatch = content.match(/@Model\(\s*{([^}]+)}\s*\)/)
        let docs: string | undefined
        let dataSource = ''

        if (modelDecoratorMatch) {
            const decoratorContent = modelDecoratorMatch[1]

            // Extract docs
            const docsMatch = decoratorContent.match(/docs:\s*["']([^"']+)["']/)
            if (docsMatch) {
                docs = docsMatch[1]
            }

            // Extract dataSource
            const dataSourceMatch = decoratorContent.match(/dataSource:\s*(\w+)/)
            if (dataSourceMatch) {
                dataSource = dataSourceMatch[1]
            }
        }

        // Extract fields
        const fields = this.extractFields(content)

        // Extract relationships (for future use)
        const relationships = this.extractRelationships(content)

        const metadata: ModelMetadata = {
            name: modelName,
            filePath,
            dataSource,
            fields,
            relationships
        }

        if (docs) {
            metadata.docs = docs
        }

        return metadata
    }

    /**
     * Extract field metadata from the model content
     */
    private extractFields(content: string): FieldMetadata[] {
        const fields: FieldMetadata[] = []

        // Match field declarations with decorators - more comprehensive pattern
        const fieldPattern = /@Field\(\s*{([^}]*)}\s*\)\s*(?:@(\w+)\(\s*(?:{([^}]*)}|\([^)]*\))?\s*\))?\s*(\w+)(?:\?)?!?:\s*([^;]+);/g

        let match
        while ((match = fieldPattern.exec(content)) !== null) {
            const fieldDecoratorContent = match[1]
            const typeDecorator = match[2]
            const typeDecoratorOptions = match[3] || ''
            const fieldName = match[4]
            const fieldType = match[5].trim()

            const field: FieldMetadata = {
                name: fieldName,
                type: this.mapTypeScriptTypeToFieldType(fieldType, typeDecorator),
                required: false
            }

            // Parse @Field decorator options
            this.parseFieldOptions(fieldDecoratorContent, field)

            // Parse type decorator options
            if (typeDecorator) {
                this.parseTypeDecoratorOptions(typeDecorator, typeDecoratorOptions, field)
            }

            // Special handling for composition types
            if (typeDecorator === 'Composition') {
                field.type = 'composition'
                // Try to extract the element type from the field type
                const elementTypeMatch = fieldType.match(/(\w+)$/)
                if (elementTypeMatch) {
                    field.type = `composition:${elementTypeMatch[1]}`
                }
            }

            fields.push(field)
        }

        return fields
    }

    /**
     * Extract relationship metadata (for future use)
     */
    private extractRelationships(content: string): RelationshipMetadata[] {
        const relationships: RelationshipMetadata[] = []

        // Pattern to match relationship decorators
        const relationshipPattern = /@(OneToOne|OneToMany|ManyToOne|ManyToMany)\([^)]*\)\s*(\w+)(?:\?)?!?:\s*([^;]+);/g

        let match
        while ((match = relationshipPattern.exec(content)) !== null) {
            const relationType = match[1] as RelationshipMetadata['type']
            const fieldName = match[2]
            const targetType = match[3].trim()

            relationships.push({
                fieldName,
                type: relationType,
                targetModel: this.extractModelNameFromType(targetType)
            })
        }

        return relationships
    }

    /**
     * Parse @Field decorator options
     */
    private parseFieldOptions(options: string, field: FieldMetadata): void {
        // Parse required
        const requiredMatch = options.match(/required:\s*(true|false|\([^)]+\)\s*=>\s*{[^}]+})/)
        if (requiredMatch) {
            if (requiredMatch[1] === 'true') {
                field.required = true
            } else if (requiredMatch[1] === 'false') {
                field.required = false
            } else {
                field.required = requiredMatch[1] // function as string
            }
        }

        // Parse primaryKey
        const primaryKeyMatch = options.match(/primaryKey:\s*(true|false)/)
        if (primaryKeyMatch) {
            field.primaryKey = primaryKeyMatch[1] === 'true'
        }

        // Parse validation
        const validationMatch = options.match(/validation:\s*(\([^)]+\)\s*=>\s*{[^}]+})/)
        if (validationMatch) {
            field.validation = validationMatch[1]
        }

        // Parse available
        const availableMatch = options.match(/available:\s*(true|false|\([^)]+\)\s*=>\s*{[^}]+})/)
        if (availableMatch) {
            if (availableMatch[1] === 'true') {
                field.available = true
            } else if (availableMatch[1] === 'false') {
                field.available = false
            } else {
                field.available = availableMatch[1] // function as string
            }
        }
    }

    /**
     * Parse type decorator options (Text, Integer, etc.)
     */
    private parseTypeDecoratorOptions(decorator: string, options: string, field: FieldMetadata): void {
        switch (decorator.toLowerCase()) {
            case 'text':
                const minLengthMatch = options.match(/minLength:\s*(\d+)/)
                if (minLengthMatch) field.minLength = parseInt(minLengthMatch[1])

                const maxLengthMatch = options.match(/maxLength:\s*(\d+)/)
                if (maxLengthMatch) field.maxLength = parseInt(maxLengthMatch[1])

                const regexMatch = options.match(/regex:\s*\/([^\/]+)\//)
                if (regexMatch) field.regex = regexMatch[1]

                const regexMessageMatch = options.match(/regexMessage:\s*["']([^"']+)["']/)
                if (regexMessageMatch) field.regexMessage = regexMessageMatch[1]
                break

            case 'integer':
            case 'float':
            case 'decimal':
                const minMatch = options.match(/min:\s*(\d+)/)
                if (minMatch) field.min = parseInt(minMatch[1])

                const maxMatch = options.match(/max:\s*(\d+)/)
                if (maxMatch) field.max = parseInt(maxMatch[1])

                if (decorator === 'decimal') {
                    const precisionMatch = options.match(/precision:\s*(\d+)/)
                    if (precisionMatch) field.precision = parseInt(precisionMatch[1])

                    const scaleMatch = options.match(/scale:\s*(\d+)/)
                    if (scaleMatch) field.scale = parseInt(scaleMatch[1])
                }
                break

            case 'uuid':
                const generatedMatch = options.match(/generated:\s*(true|false)/)
                if (generatedMatch) field.generated = generatedMatch[1] === 'true'
                break
        }
    }

    /**
     * Map TypeScript types to field types
     */
    private mapTypeScriptTypeToFieldType(tsType: string, decorator?: string): string {
        if (decorator) {
            return decorator.toLowerCase()
        }

        switch (tsType.toLowerCase()) {
            case 'string': return 'text'
            case 'number': return 'integer'
            case 'boolean': return 'boolean'
            case 'date': return 'date'
            default: return 'text'
        }
    }

    /**
     * Extract model name from TypeScript type
     */
    private extractModelNameFromType(type: string): string {
        // Handle arrays like "Person[]"
        if (type.endsWith('[]')) {
            return type.slice(0, -2)
        }
        return type
    }
}