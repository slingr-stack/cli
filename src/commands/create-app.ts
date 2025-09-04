import { Args, Command, Flags } from '@oclif/core'
import fse from 'fs-extra'
import inquirer from 'inquirer'
import path from 'node:path'

import { AppAnswers, createProjectStructure } from '../project-structure.js'

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

    this.log('')
    this.log('Hi! Before we get started, we are going to ask you some information about your application.')
    this.log('')

    // Interactive questions
    const answers = await inquirer.prompt<AppAnswers>([
      {
        message: 'What type of application are you going to create? ',
        name: 'appType',
        suffix: "For example, a CRM, a task manager, an ERP, etc.\n",
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
      },
      {
        type: 'list',
        name: 'database',
        message: 'Which database do you want to use?',
        choices: [
          { name: 'PostgreSQL', value: 'postgres' },
          { name: 'MySQL', value: 'mysql' }
        ],
        default: 'postgres'
      },
      {
        message: 'Perfect! Please, provide a description of what your app needs to do:\n',
        name: 'description',
        type: 'input',
        validate: (input: string) => input.length > 0 || 'Please provide a description'
      }
    ])

    this.log('')
    this.log("That's very useful, thanks for the information!")
    this.log('')

    // Create the project structure
    await createProjectStructure(appName, answers)

    this.log(`Project ${appName} created successfully!`)
    this.log(`To get started:`)
    this.log(`  cd ${appName}`)
    this.log(`  npm install`)
  }

}