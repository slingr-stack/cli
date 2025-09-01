import fse from 'fs-extra'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppAnswers {
    appType: string
    description: string
    hasBackend: boolean
    hasFrontend: boolean
}

async function copyTemplateFile(templatePath: string, targetPath: string, replacements?: Record<string, string>): Promise<void> {
    let content = await fse.readFile(templatePath, 'utf8')

    // Apply replacements if provided
    if (replacements) {
        for (const [placeholder, value] of Object.entries(replacements)) {
            content = content.replaceAll(placeholder, value)
        }
    }

    await fse.outputFile(targetPath, content)
}

export async function createProjectStructure(appName: string, answers: AppAnswers): Promise<void> {
    const targetDir = path.join(process.cwd(), appName)
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    // When running from dist/, we need to go up one level to reach the project root
    const projectRoot = path.resolve(currentDir, '..')
    const templatesDir = path.join(projectRoot, 'src', 'templates')

    // Create directory structure
    await fse.ensureDir(targetDir)
    await fse.ensureDir(path.join(targetDir, '.vscode'))
    await fse.ensureDir(path.join(targetDir, '.github'))
    await fse.ensureDir(path.join(targetDir, 'src', 'data'))
    await fse.ensureDir(path.join(targetDir, 'docs'))

    // Copy .vscode files from templates
    await fse.copy(
        path.join(templatesDir, 'vscode', 'extensions.json'),
        path.join(targetDir, '.vscode', 'extensions.json')
    )

    await fse.copy(
        path.join(templatesDir, 'vscode', 'settings.json'),
        path.join(targetDir, '.vscode', 'settings.json')
    )

    // Copy tsconfig.json from templates
    await fse.copy(
        path.join(templatesDir, 'config', 'tsconfig.json'),
        path.join(targetDir, 'tsconfig.json')
    )

    // Copy .gitignore from templates
    await fse.copy(
        path.join(templatesDir, 'config', '.gitignore'),
        path.join(targetDir, '.gitignore')
    )

    // Copy jest.config.ts from templates
    await fse.copy(
        path.join(templatesDir, 'config', 'jest.config.ts'),
        path.join(targetDir, 'jest.config.ts')
    )

    // Copy jest.setup.ts from templates
    await fse.copy(
        path.join(templatesDir, 'config', 'jest.setup.ts'),
        path.join(targetDir, 'jest.setup.ts')
    )

    // Copy and process src files from templates
    const replacements = {
        '{{APP_NAME}}': appName
    }

    await copyTemplateFile(
        path.join(templatesDir, 'src', 'index.ts'),
        path.join(targetDir, 'src', 'index.ts'),
        replacements
    )

    // Copy sample model files
    await fse.copy(
        path.join(templatesDir, 'src', 'SampleModel.ts'),
        path.join(targetDir, 'src', 'data', 'SampleModel.ts')
    )

    await fse.copy(
        path.join(templatesDir, 'src', 'SampleModel.test.ts'),
        path.join(targetDir, 'src', 'data', 'SampleModel.test.ts')
    )

    // Create .github/copilot-instructions.md (kept as dynamic generation)
    const copilotInstructions = `# GitHub Copilot Instructions for ${appName}

This is a ${answers.appType} application built with Slingr.

## Project Description
${answers.description}

## Architecture
- Backend: ${answers.hasBackend ? 'Yes' : 'No'}
- Frontend: ${answers.hasFrontend ? 'Yes' : 'No'}

## Development Guidelines
- Use TypeScript for all code
- Follow Slingr conventions and patterns
- Maintain clean, readable code with proper documentation
- Use the provided data models as starting points
`
    await fse.writeFile(path.join(targetDir, '.github', 'copilot-instructions.md'), copilotInstructions)

    // Create package.json (kept as dynamic generation)
    const packageJson = {
        author: '',
        dependencies: {},
        description: answers.description,
        devDependencies: {
            '@types/jest': '^29.5.0',
            '@types/node': '^20.0.0',
            'jest': '^29.5.0',
            'ts-jest': '^29.1.0',
            'ts-node': '^10.9.0',
            'typescript': '^5.0.0',
            'slingr-framework': 'github:slingr-stack/framework',
            "reflect-metadata": "^0.2.2",
            "class-transformer": "^0.5.1",
            "class-validator": "^0.14.2",
            "financial-number": "^4.0.4",
        },
        keywords: [
            'slingr',
            answers.appType.toLowerCase().replaceAll(/\s+/g, '-')
        ],
        license: 'MIT',
        main: 'dist/index.js',
        name: appName,
        scripts: {
            build: 'tsc',
            dev: 'ts-node src/index.ts',
            test: 'jest',
            'test:watch': 'jest --watch'
        },
        version: '1.0.0'
    }
    await fse.outputJson(path.join(targetDir, 'package.json'), packageJson, { spaces: 2 })

    // Create docs/app-description.md (kept as dynamic generation)
    const appDescription = `# ${appName}

## Overview
${answers.description}

## Application Type
${answers.appType}

## Architecture
- **Backend**: ${answers.hasBackend ? 'Included' : 'Not included'}
- **Frontend**: ${answers.hasFrontend ? 'Included' : 'Not included'}

## Getting Started

1. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

2. Start development:
   \`\`\`bash
   npm run dev
   \`\`\`

3. Build for production:
   \`\`\`bash
   npm run build
   \`\`\`

## Development
- Use TypeScript for all development
- Follow the established patterns in the \`src/data\` directory
- Refer to the GitHub Copilot instructions in \`.github/copilot-instructions.md\`
`
    await fse.writeFile(path.join(targetDir, 'docs', 'app-description.md'), appDescription)
}
