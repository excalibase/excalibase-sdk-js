import { gql } from "graphql-request";

export const CATEGORIES = gql`
  query Categories {
    shopifyCategories(orderBy: { id: ASC }) {
      id
      name
      slug
    }
  }
`;

export const PRODUCTS = gql`
  query Products($categoryId: Int) {
    shopifyProducts(
      where: $categoryId == null ? {} : { category_id: { eq: $categoryId } },
      orderBy: { id: ASC }
    ) {
      id
      name
      slug
      price
      category_id
      status
      shopifyProductVariants(orderBy: { id: ASC }) {
        id
        sku
        color
        size
        stock_quantity
        price_override
      }
      shopifyReviews {
        id
        rating
      }
    }
  }
`;

// Variant-substitution-friendly version (graphql-request can't conditionally
// drop $where) — we just template the where clause based on filter.
export function productsQuery(categoryId: number | null): string {
  const filter = categoryId == null ? "" : `(where: { category_id: { eq: ${categoryId} } })`;
  return `
    query Products {
      shopifyProducts${filter}{
        id
        name
        slug
        price
        category_id
        status
        shopifyProductVariants(orderBy: { id: ASC }) {
          id sku color size stock_quantity price_override
        }
        shopifyReviews { id rating }
      }
      shopifyCategories(orderBy: { id: ASC }) { id name slug }
    }
  `;
}

export const PRODUCT_DETAIL = gql`
  query ProductDetail($id: Int!) {
    shopifyProducts(where: { id: { eq: $id } }) {
      id
      name
      slug
      price
      category_id
      status
      metadata
      shopifyProductVariants(orderBy: { id: ASC }) {
        id
        sku
        color
        size
        stock_quantity
        price_override
      }
      shopifyReviews(orderBy: { created_at: DESC }) {
        id
        rating
        title
        body
        customer_id
        created_at
      }
    }
  }
`;

export const MY_ORDERS = gql`
  query MyOrders {
    shopifyOrders(orderBy: { id: DESC }) {
      id
      status
      total
      notes
      created_at
      shopifyOrderItems {
        id
        quantity
        price_at_purchase
        shopifyProductVariants {
          id
          sku
          color
          shopifyProducts {
            id
            name
            slug
          }
        }
      }
    }
  }
`;

export const ALL_ORDERS_ADMIN = gql`
  query AllOrders {
    shopifyOrders(orderBy: { id: DESC }, limit: 100) {
      id
      status
      total
      customer_id
      created_at
      shopifyCustomers {
        id
        name
        email
      }
    }
  }
`;

export const WHOAMI = gql`
  query Whoami {
    shopifyWhoamiView {
      role
    }
  }
`;
