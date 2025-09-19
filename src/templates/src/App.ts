import { Field, Text, Model, BaseModel, Reference } from "slingr-framework";
import { Company } from "./Company";

@Model({
    docs: "Represents an application containing info",
})
export class App extends BaseModel {

    @Field({
        docs: "The name of the application",
        required: true
    })
    @Text({
        minLength: 4,
        maxLength: 20,
        // Regex: allows letters, dots (not at start/end), no underscores, no consecutive dots
        regex: /^(?!\.)([a-zA-Z]+(\.[a-zA-Z]+)*)?(?<!\.)$/,
        regexMessage: "Name must contain only letters and dots (no underscores, no consecutive dots, no dot at start/end)",
    })
    name!: string;

    @Field({
        docs: "The version of the application in format AA.BB.CC",
        required: true
    })
    @Text({
        minLength: 5,
        maxLength: 8,
        regex: /^\d{2}\.\d{2}\.\d{2}$/,
        regexMessage: "Version must be in the format AA.BB.CC, where AA, BB, and CC are two-digit numbers"
    })
    version!: string;

    @Field({
        docs: "The description of the application"
    })
    @Text({
        minLength: 10,
        maxLength: 500,
    })
    description!: string;

    @Field({
        docs: "The owning company of the application",
        required: true
    })
    @Reference({ load: true })
    ownerCompany!: Company;
}