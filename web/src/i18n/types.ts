export type CatalogShape<T> = T extends (...args: infer Args) => string
	? (...args: Args) => string
	: T extends string ? string : { [Key in keyof T]: CatalogShape<T[Key]> };
