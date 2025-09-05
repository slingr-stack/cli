import { Command, Flags } from '@oclif/core'
import path from 'node:path'
import fs from 'fs-extra'
import { execSync } from 'child_process'

export default class Run extends Command {
    static override description = 'Run a Slingr application locally'

    static override examples = [
        '<%= config.bin %> <%= command.id %>',
        '<%= config.bin %> <%= command.id %> --skip-infra'
    ]

    static override flags = {
        'skip-infra': Flags.boolean({
            char: 'i',
            description: 'Skip infrastructure setup and checks',
            required: false,
        }),
        help: Flags.help({ char: 'h' })
    }

    private async checkInfrastructure(): Promise<void> {
        const dataSources = await this.loadDataSources()

        // Run infra update command to ensure latest infrastructure configuration
        await this.config.runCommand('infra:update', ['--all'])

        // Check if docker is installed
        try {
            execSync('docker --version', { stdio: 'pipe' })
        } catch (error) {
            this.error('Docker is not installed. Please install Docker to run infrastructure services.')
        }

        // Check if docker-compose is installed
        try {
            execSync('docker compose version', { stdio: 'pipe' })
        } catch (error) {
            this.error('Docker Compose is not installed. Please install Docker Compose to run infrastructure services.')
        }

        // Start infrastructure services
        this.log('Starting infrastructure services...')
        execSync('docker compose up -d', { stdio: 'inherit' })

        // Wait for services to be healthy
        this.log('Waiting for services to be ready...')
        for (const ds of dataSources) {
            const serviceName = `${ds.name}-db`
            this.log(`Checking ${serviceName}...`)

            let attempts = 0
            const maxAttempts = 30

            while (attempts < maxAttempts) {
                try {
                    const containerInfo = execSync(`docker ps -f name=${serviceName} --format '{{.Status}}'`, { encoding: 'utf-8' })
                    
                    if (containerInfo.includes('healthy')) {
                        this.log(`Service ${serviceName} is healthy`)
                        break
                    }
                } catch (error) {
                    // Continue trying
                }

                await new Promise(resolve => setTimeout(resolve, 1000))
                attempts++

                if (attempts === maxAttempts) {
                    this.error(`Service ${serviceName} is not healthy after ${maxAttempts} seconds`)
                }
            }
        }
    }

    private async loadDataSources(): Promise<Array<{ type: string; name: string }>> {
        const dataSources: Array<{ type: string; name: string }> = []
        const dataSourcesPath = path.join(process.cwd(), 'src', 'dataSources')

        if (await fs.pathExists(dataSourcesPath)) {
            const files = await fs.readdir(dataSourcesPath)
            for (const file of files) {
                if (file.endsWith('.ts')) {
                    const content = await fs.readFile(path.join(dataSourcesPath, file), 'utf-8')
                    const typeMatch = content.match(/type:\s*['"]([^'"]+)['"]/)
                    if (typeMatch) {
                        let type = typeMatch[1]
                        if (type === 'postgresql') type = 'postgres'

                        dataSources.push({
                            type,
                            name: file.replace('.ts', '')
                        })
                    }
                }
            }
        }

        return dataSources
    }

    private async generateCode(): Promise<void> {
        // Compile TypeScript code
        this.log('Compiling TypeScript code...')
        execSync('npm run build', { stdio: 'inherit' })
    }

    public async run(): Promise<void> {
        const { flags } = await this.parse(Run)

        try {
            // Check if we're in a Slingr app directory
            const packageJsonPath = path.join(process.cwd(), 'package.json')
            if (!await fs.pathExists(packageJsonPath)) {
                this.error('Not in a Slingr application directory. Please run this command from your app\'s root directory.')
            }

            const packageJson = await fs.readJSON(packageJsonPath)
            if (!packageJson.dependencies?.['slingr-framework']) {
                this.error('This directory does not contain a Slingr application.')
            }

            // Step 1: Generate code
            await this.generateCode()

            // Step 2 & 3: Update and check infrastructure
            if (!flags['skip-infra']) {
                await this.checkInfrastructure()
            }

            // Execute index.ts
            this.log('Starting application...')
            execSync('npm run dev', { stdio: 'inherit' })

        } catch (error) {
            this.error((error as Error).message)
        }
    }
}
