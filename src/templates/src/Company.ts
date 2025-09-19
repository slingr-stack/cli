import { Field, Text, Model, BaseModel, Composition } from "slingr-framework";
import { Person } from "./Person";

@Model({
    docs: "Represents a company with composition of employees and reference to an application",
})
export class Company extends BaseModel {
    @Field({
        docs: "The name of the company",
        required: true
    })
    @Text({
        minLength: 2,
        maxLength: 100,
        regex: /^[a-zA-Z0-9\s&.-]+$/,
        regexMessage: "Company name must contain only letters, numbers, spaces, ampersands, dots, and hyphens"
    })
    name!: string;

    @Field({
        docs: "The CEO of the company (composition)",
        required: true
    })
    @Composition({ elementType: () => Person })
    ceo!: Person;


}