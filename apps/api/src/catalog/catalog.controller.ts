import { Controller } from '@nestjs/common';
import {
  routes,
  type Category,
  type Location,
  type ParsedInput,
  type Product,
  type ProductPage,
  type Supplier,
  type Variant,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AuthContext } from '../common/endpoint.js';
import { CategoriesService } from './categories.service.js';
import { LocationsService } from './locations.service.js';
import { ProductsService } from './products.service.js';
import { SuppliersService } from './suppliers.service.js';

@Controller()
export class CatalogController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
    private readonly locations: LocationsService,
    private readonly suppliers: SuppliersService,
  ) {}

  @Endpoint(routes.listSuppliers)
  listSuppliers(@Auth() auth: AuthContext): Promise<Supplier[]> {
    return this.suppliers.list(auth);
  }

  @Endpoint(routes.createSupplier)
  createSupplier(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createSupplier>,
  ): Promise<Supplier> {
    return this.suppliers.create(auth, input.body);
  }

  @Endpoint(routes.updateSupplier)
  updateSupplier(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateSupplier>,
  ): Promise<Supplier> {
    return this.suppliers.update(auth, input.params.id, input.body);
  }

  @Endpoint(routes.listCategories)
  listCategories(@Auth() auth: AuthContext): Promise<Category[]> {
    return this.categories.list(auth);
  }

  @Endpoint(routes.createCategory)
  createCategory(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createCategory>,
  ): Promise<Category> {
    return this.categories.create(auth, input.body);
  }

  @Endpoint(routes.updateCategory)
  updateCategory(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateCategory>,
  ): Promise<Category> {
    return this.categories.rename(auth, input.params.id, input.body);
  }

  @Endpoint(routes.deleteCategory)
  async deleteCategory(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.deleteCategory>,
  ): Promise<Record<string, never>> {
    await this.categories.remove(auth, input.params.id);
    return {};
  }

  @Endpoint(routes.listProducts)
  listProducts(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listProducts>,
  ): Promise<ProductPage> {
    return this.products.list(auth, input.query);
  }

  @Endpoint(routes.getProduct)
  getProduct(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getProduct>,
  ): Promise<Product> {
    return this.products.get(auth, input.params.id);
  }

  @Endpoint(routes.createProduct)
  createProduct(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createProduct>,
  ): Promise<Product> {
    return this.products.create(auth, input.body);
  }

  @Endpoint(routes.updateProduct)
  updateProduct(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateProduct>,
  ): Promise<Product> {
    return this.products.update(auth, input.params.id, input.body);
  }

  @Endpoint(routes.addVariant)
  addVariant(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.addVariant>,
  ): Promise<Variant> {
    return this.products.addVariant(auth, input.params.id, input.body);
  }

  @Endpoint(routes.updateVariant)
  updateVariant(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateVariant>,
  ): Promise<Variant> {
    return this.products.updateVariant(auth, input.params.id, input.body);
  }

  @Endpoint(routes.listLocations)
  listLocations(@Auth() auth: AuthContext): Promise<Location[]> {
    return this.locations.list(auth);
  }

  @Endpoint(routes.createLocation)
  createLocation(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createLocation>,
  ): Promise<Location> {
    return this.locations.create(auth, input.body);
  }

  @Endpoint(routes.updateLocation)
  updateLocation(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateLocation>,
  ): Promise<Location> {
    return this.locations.update(auth, input.params.id, input.body);
  }
}
