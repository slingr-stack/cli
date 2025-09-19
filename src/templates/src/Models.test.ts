import { App } from './App';
import { Person } from './Person';
import { Company } from './Company';

describe('Models Integration Tests', () => {
    describe('Person Model', () => {
        it('should validate a valid adult person', async () => {
            const personData = {
                firstName: 'John',
                lastName: 'Doe',
                email: 'john@example.com',
                age: 25,
                phoneNumber: '123-456-7890',
                additionalInfo: '<p>Senior Developer</p>',
                isActive: true
            };

            const person = Person.fromJSON(personData);
            const errors = await person.validate();

            expect(errors.length).toBe(0);
            expect(person.firstName).toBe('John');
            expect(person.lastName).toBe('Doe');
            expect(person.age).toBe(25);
            expect(person.isActive).toBe(true);
        });

        it('should validate a valid minor person with parent email', async () => {
            const personData = {
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane@example.com',
                age: 16,
                parentEmail: 'parent@example.com',
                additionalInfo: '<p>Student</p>',
                isActive: true
            };

            const person = Person.fromJSON(personData);
            const errors = await person.validate();

            expect(errors.length).toBe(0);
            expect(person.parentEmail).toBe('parent@example.com');
        });

        it('should fail validation when firstName is too short', async () => {
            const personData = {
                firstName: 'J',
                lastName: 'Doe',
                email: 'john@example.com',
                age: 25
            };

            const person = Person.fromJSON(personData);
            const errors = await person.validate();

            expect(errors.length).toBeGreaterThan(0);
            const firstNameError = errors.find(e => e.property === 'firstName');
            expect(firstNameError).toBeDefined();
            expect(firstNameError?.constraints).toHaveProperty('minLength');
        });

        it('should fail validation when firstName contains numbers', async () => {
            const personData = {
                firstName: 'John123',
                lastName: 'Doe',
                email: 'john@example.com',
                age: 25
            };

            const person = Person.fromJSON(personData);
            const errors = await person.validate();

            expect(errors.length).toBeGreaterThan(0);
            const firstNameError = errors.find(e => e.property === 'firstName');
            expect(firstNameError).toBeDefined();
            expect(firstNameError?.constraints).toHaveProperty('matches');
        });

        it('should fail validation when email is invalid', async () => {
            const personData = {
                firstName: 'John',
                lastName: 'Doe',
                email: 'invalid-email',
                age: 25
            };

            const person = Person.fromJSON(personData);
            const errors = await person.validate();

            expect(errors.length).toBeGreaterThan(0);
            const emailError = errors.find(e => e.property === 'email');
            expect(emailError).toBeDefined();
            expect(emailError?.constraints).toHaveProperty('isEmail');
        });

        it('should fail validation when age is negative', async () => {
            const personData = {
                firstName: 'John',
                lastName: 'Doe',
                email: 'john@example.com',
                age: -5
            };

            const person = Person.fromJSON(personData);
            const errors = await person.validate();

            expect(errors.length).toBeGreaterThan(0);
            const ageError = errors.find(e => e.property === 'age');
            expect(ageError).toBeDefined();
            expect(ageError?.constraints).toHaveProperty('invalidAge');
        });

        it('should require parentEmail for minors', async () => {
            const personData = {
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane@example.com',
                age: 16
                // parentEmail missing
            };

            const person = Person.fromJSON(personData);
            const errors = await person.validate();

            expect(errors.length).toBeGreaterThan(0);
            const parentEmailError = errors.find(e => e.property === 'parentEmail');
            expect(parentEmailError).toBeDefined();
        });

        it('should exclude internalId from JSON output', () => {
            const personData = {
                firstName: 'John',
                lastName: 'Doe',
                email: 'john@example.com',
                age: 25,
                internalId: 'secret-123',
                isActive: true
            };

            const person = Person.fromJSON(personData);
            const json = person.toJSON();

            expect(json).not.toHaveProperty('internalId');
            expect(json).toHaveProperty('firstName', 'John');
        });
    });

    describe('Company Model', () => {
        let validCEO: Person;

        beforeEach(() => {
            const ceoData = {
                firstName: 'Robert',
                lastName: 'Johnson',
                email: 'robert@company.com',
                age: 45,
                phoneNumber: '+1987654321',
                additionalInfo: '<p>CEO and Founder</p>',
                isActive: true
            };
            validCEO = Person.fromJSON(ceoData);
        });

        it('should validate a valid company with CEO composition', async () => {
            const companyData = {
                name: "TechCorp Solutions",
                ceo: validCEO
            };

            const company = Company.fromJSON(companyData);
            const errors = await company.validate();

            expect(errors.length).toBe(0);
            expect(company.name).toBe("TechCorp Solutions");
            expect(company.ceo).toBeDefined();
            expect(company.ceo.firstName).toBe("Robert");
            expect(company.ceo.lastName).toBe("Johnson");
        });

        it('should fail validation with invalid company name (too short)', async () => {
            const companyData = {
                name: "X", // Too short
                ceo: validCEO
            };

            const company = Company.fromJSON(companyData);
            const errors = await company.validate();

            expect(errors.length).toBeGreaterThan(0);
            const nameError = errors.find(e => e.property === 'name');
            expect(nameError).toBeDefined();
            expect(nameError?.constraints).toHaveProperty('minLength');
        });

        it('should fail validation with invalid company name (special chars)', async () => {
            const companyData = {
                name: "Company@#$%", // Invalid characters
                ceo: validCEO
            };

            const company = Company.fromJSON(companyData);
            const errors = await company.validate();

            expect(errors.length).toBeGreaterThan(0);
            const nameError = errors.find(e => e.property === 'name');
            expect(nameError).toBeDefined();
            expect(nameError?.constraints).toHaveProperty('matches');
        });

        it('should fail validation when CEO is missing', async () => {
            const companyData = {
                name: "ValidCompany"
                // ceo is missing
            };

            const company = Company.fromJSON(companyData);
            const errors = await company.validate();

            expect(errors.length).toBeGreaterThan(0);
            const ceoError = errors.find(e => e.property === 'ceo');
            expect(ceoError).toBeDefined();
        });

        it('should validate company with valid name containing dots and ampersands', async () => {
            const companyData = {
                name: "Tech & Solutions Co.",
                ceo: validCEO
            };

            const company = Company.fromJSON(companyData);
            const errors = await company.validate();

            expect(errors.length).toBe(0);
            expect(company.name).toBe("Tech & Solutions Co.");
        });
    });

    describe('App Model', () => {
        let validCompany: Company;

        beforeEach(() => {
            const ceoData = {
                firstName: 'Sarah',
                lastName: 'Davis',
                email: 'sarah@company.com',
                age: 40,
                phoneNumber: '+1111222333',
                additionalInfo: '<p>Visionary CEO</p>',
                isActive: true
            };
            const ceo = Person.fromJSON(ceoData);

            const companyData = {
                name: "TechCorp Solutions",
                ceo: ceo
            };
            validCompany = Company.fromJSON(companyData);
        });

        it('should validate a valid app with owner company reference', async () => {
            const appData = {
                name: "SlingrApp",
                version: "01.00.01",
                description: "A comprehensive application framework for building modern web applications",
                ownerCompany: validCompany
            };

            const app = App.fromJSON(appData);
            const errors = await app.validate();

            expect(errors.length).toBe(0);
            expect(app.name).toBe("SlingrApp");
            expect(app.version).toBe("01.00.01");
            expect(app.ownerCompany).toBeDefined();
            expect(app.ownerCompany.name).toBe("TechCorp Solutions");
        });

        it('should fail validation with invalid name format (starts with dot)', async () => {
            const appData = {
                name: ".InvalidApp",
                version: "01.00.01",
                description: "A comprehensive application framework",
                ownerCompany: validCompany
            };

            const app = App.fromJSON(appData);
            const errors = await app.validate();

            expect(errors.length).toBeGreaterThan(0);
            const nameError = errors.find(e => e.property === 'name');
            expect(nameError).toBeDefined();
            expect(nameError?.constraints).toHaveProperty('matches');
        });

        it('should fail validation with invalid version format', async () => {
            const appData = {
                name: "ValidApp",
                version: "1.0.1", // Should be 01.00.01
                description: "A comprehensive application framework",
                ownerCompany: validCompany
            };

            const app = App.fromJSON(appData);
            const errors = await app.validate();

            expect(errors.length).toBeGreaterThan(0);
            const versionError = errors.find(e => e.property === 'version');
            expect(versionError).toBeDefined();
            expect(versionError?.constraints).toHaveProperty('matches');
        });

        it('should fail validation when owner company is missing', async () => {
            const appData = {
                name: "ValidApp",
                version: "01.00.01",
                description: "A comprehensive application framework"
                // ownerCompany is missing
            };

            const app = App.fromJSON(appData);
            const errors = await app.validate();

            expect(errors.length).toBeGreaterThan(0);
            const ownerError = errors.find(e => e.property === 'ownerCompany');
            expect(ownerError).toBeDefined();
        });

        it('should validate app with valid name containing dots', async () => {
            const appData = {
                name: "App.Module.Core",
                version: "02.05.12",
                description: "A modular application core component",
                ownerCompany: validCompany
            };

            const app = App.fromJSON(appData);
            const errors = await app.validate();

            expect(errors.length).toBe(0);
            expect(app.name).toBe("App.Module.Core");
        });
    });

    describe('Full Integration Tests', () => {
        it('should handle complete model relationships', async () => {
            // Create a CEO
            const ceoData = {
                firstName: 'John',
                lastName: 'Smith',
                email: 'john.smith@techcorp.com',
                age: 45,
                phoneNumber: '+1555123456',
                additionalInfo: '<p>Experienced technology leader</p>',
                isActive: true
            };
            const ceo = Person.fromJSON(ceoData);

            // Create a company with the CEO (composition)
            const companyData = {
                name: "TechCorp Innovation Labs",
                ceo: ceo
            };
            const company = Company.fromJSON(companyData);

            // Create an app that references the company
            const appData = {
                name: "InnovationPlatform",
                version: "03.01.05",
                description: "A cutting-edge platform for technological innovation and development",
                ownerCompany: company
            };
            const app = App.fromJSON(appData);

            // Validate all models
            const ceoErrors = await ceo.validate();
            const companyErrors = await company.validate();
            const appErrors = await app.validate();

            expect(ceoErrors.length).toBe(0);
            expect(companyErrors.length).toBe(0);
            expect(appErrors.length).toBe(0);

            // Verify relationships
            expect(app.ownerCompany.name).toBe("TechCorp Innovation Labs");
            expect(app.ownerCompany.ceo.firstName).toBe("John");
            expect(company.ceo.email).toBe("john.smith@techcorp.com");
        });

        it('should properly serialize complete model hierarchy', () => {
            const ceoData = {
                firstName: 'Alice',
                lastName: 'Wilson',
                email: 'alice@startup.com',
                age: 35,
                phoneNumber: '+1444555666',
                isActive: true
            };
            const ceo = Person.fromJSON(ceoData);

            const companyData = {
                name: "StartupCorp",
                ceo: ceo
            };
            const company = Company.fromJSON(companyData);

            const appData = {
                name: "StartupApp",
                version: "01.00.01",
                description: "A revolutionary startup application",
                ownerCompany: company
            };
            const app = App.fromJSON(appData);

            // Serialize to JSON
            const appJson = app.toJSON();

            // Verify the JSON structure
            expect(appJson).toHaveProperty('name', 'StartupApp');
            expect(appJson).toHaveProperty('version', '01.00.01');
            expect(appJson).toHaveProperty('ownerCompany');
            expect(appJson.ownerCompany).toHaveProperty('name', 'StartupCorp');
            expect(appJson.ownerCompany).toHaveProperty('ceo');
            expect(appJson.ownerCompany.ceo).toHaveProperty('firstName', 'Alice');
        });
    });
});