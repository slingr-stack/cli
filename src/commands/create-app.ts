import { Args, Command, Flags } from '@oclif/core'
import fse from 'fs-extra'
import inquirer from 'inquirer'
import path from 'node:path'

interface AppAnswers {
  appType: string
  description: string
  hasBackend: boolean
  hasFrontend: boolean
}

export default class CreateApp extends Command {
  static override args = {
    name: Args.string({
      description: 'Name of the application to create',
      required: true
    })
  }
  static override description = 'Create a new Slingr application'
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> task-manager'
  ]
  static override flags = {
    help: Flags.help({ char: 'h' })
  }

  public async run(): Promise<void> {
    const { args } = await this.parse(CreateApp)
    const appName = args.name

    // Check if directory already exists
    const targetDir = path.join(process.cwd(), appName)
    if (await fse.pathExists(targetDir)) {
      this.error(`Directory ${appName} already exists!`)
    }

    this.log('Hi! Before we get started, we are going to ask you some information about your application.')
    this.log('')

    // Interactive questions
    const answers = await inquirer.prompt<AppAnswers>([
      {
        message: 'What type of application are you going to create? For example, a CRM, a task manager, an ERP, etc.',
        name: 'appType',
        type: 'input',
        validate: (input: string) => input.length > 0 || 'Please provide an application type'
      },
      {
        default: true,
        message: 'OK! Now, are you going to create a backend for your app?',
        name: 'hasBackend',
        type: 'confirm'
      },
      {
        default: true,
        message: 'Good! Do you also want to create the frontend with Slingr?',
        name: 'hasFrontend',
        type: 'confirm',
        when: (answers: Partial<AppAnswers>) => answers.hasBackend
      },
      {
        message: 'Perfect! Please, provide a description of what your app needs to do:',
        name: 'description',
        type: 'input',
        validate: (input: string) => input.length > 0 || 'Please provide a description'
      }
    ])

    this.log('')
    this.log("That's very useful, thanks for the information!")
    this.log('')

    // Create the project structure
    await this.createProjectStructure(appName, answers)

    this.log(`Project ${appName} created successfully!`)
    this.log(`To get started:`)
    this.log(`  cd ${appName}`)
    this.log(`  npm install`)
  }

  private async createProjectStructure(appName: string, answers: AppAnswers): Promise<void> {
    const targetDir = path.join(process.cwd(), appName)

    // Create directory structure
    await fse.ensureDir(targetDir)
    await fse.ensureDir(path.join(targetDir, '.vscode'))
    await fse.ensureDir(path.join(targetDir, '.github'))
    await fse.ensureDir(path.join(targetDir, 'src', 'data'))
    await fse.ensureDir(path.join(targetDir, 'docs'))

    // Create .vscode/extensions.json
    const extensionsConfig = {
      recommendations: [
        'github.copilot',
        'slingr.slingr'
      ]
    }
    await fse.outputJson(path.join(targetDir, '.vscode', 'extensions.json'), extensionsConfig, { spaces: 2 })

    // Create .vscode/settings.json
    const settingsConfig = {
      'editor.formatOnSave': true,
      'editor.inlineSuggest.enabled': true,
      'github.copilot.advanced': {},
      'github.copilot.enable': {
        '*': true,
        'markdown': true,
        'plaintext': true
      },
      'typescript.preferences.importModuleSpecifier': 'relative'
    }
    await fse.outputJson(path.join(targetDir, '.vscode', 'settings.json'), settingsConfig, { spaces: 2 })

    // Create .github/copilot-instructions.md
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

    // Create package.json
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
        'typescript': '^5.0.0'
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

    // Create tsconfig.json
    const tsConfig = {
      compilerOptions: {
        declaration: true,
        declarationMap: true,
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        lib: ['ES2020'],
        module: 'commonjs',
        outDir: './dist',
        resolveJsonModule: true,
        rootDir: './src',
        skipLibCheck: true,
        sourceMap: true,
        strict: true,
        target: 'ES2020'
      },
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
      include: ['src/**/*']
    }
    await fse.outputJson(path.join(targetDir, 'tsconfig.json'), tsConfig, { spaces: 2 })

    // Create docs/app-description.md
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

    // Create sample model
    const sampleModel = ``
    await fse.writeFile(path.join(targetDir, 'src', 'data', 'SampleModel.ts'), sampleModel)

    // Create sample model test
    const sampleModelTest = ``
    await fse.writeFile(path.join(targetDir, 'src', 'data', 'SampleModel.test.ts'), sampleModelTest)

    // Create main index file
    const indexFile = `export * from './data/SampleModel';

// Main entry point for the ${appName} application
console.log('${appName} application initialized');
`
    await fse.writeFile(path.join(targetDir, 'src', 'index.ts'), indexFile)
  }
}
