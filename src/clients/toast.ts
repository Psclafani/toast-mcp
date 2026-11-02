import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import type {
  ToastConfig,
  ToastAuthToken,
  ToastError,
  PaginationParams,
  PaginatedResponse,
} from '../types/index.js';

export class ToastClient {
  private axiosInstance: AxiosInstance;
  private authToken?: ToastAuthToken;
  private tokenExpiration?: number;
  private config: ToastConfig;
  private baseURL: string;

  constructor(config: ToastConfig) {
    this.config = config;
    this.baseURL =
      config.environment === 'sandbox'
        ? 'https://ws-sandbox-api.eng.toasttab.com'
        : 'https://ws-api.toasttab.com';

    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Request interceptor for auth
    this.axiosInstance.interceptors.request.use(
      async (config) => {
        await this.ensureValidToken();
        if (this.authToken) {
          config.headers.Authorization = `Bearer ${this.authToken.access_token}`;
        }
        // Add Toast-Restaurant-External-ID header if available — but never
        // overwrite a per-call restaurantGuid override already set on the request.
        if (this.config.restaurantGuid && !config.headers['Toast-Restaurant-External-ID']) {
          config.headers['Toast-Restaurant-External-ID'] = this.config.restaurantGuid;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        return Promise.reject(this.handleError(error));
      }
    );
  }

  /**
   * Ensure we have a valid authentication token
   */
  private async ensureValidToken(): Promise<void> {
    const now = Date.now();

    // Check if token exists and is still valid (with 5 minute buffer)
    if (this.authToken && this.tokenExpiration && this.tokenExpiration > now + 300000) {
      return;
    }

    // Get new token
    await this.authenticate();
  }

  /**
   * Authenticate with Toast API using client credentials
   */
  private async authenticate(): Promise<void> {
    try {
      const authURL =
        this.config.environment === 'sandbox'
          ? 'https://ws-sandbox-api.eng.toasttab.com/authentication/v1/authentication/login'
          : 'https://ws-api.toasttab.com/authentication/v1/authentication/login';

      const response = await axios.post<ToastAuthToken>(
        authURL,
        {
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          userAccessType: 'TOAST_MACHINE_CLIENT',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      // Toast returns { token: { accessToken, expiresIn, ... } }, not an OAuth2-style flat object
      const raw = response.data as any;
      this.authToken = {
        access_token: raw?.token?.accessToken ?? raw?.access_token,
        token_type: raw?.token?.tokenType ?? raw?.token_type ?? 'Bearer',
        expires_in: raw?.token?.expiresIn ?? raw?.expires_in ?? 0,
        scope: raw?.token?.scope ?? raw?.scope ?? '',
      };
      if (!this.authToken.access_token) {
        throw new Error('Toast authentication succeeded but no access token was found in the response');
      }
      // Calculate expiration timestamp
      this.tokenExpiration = Date.now() + this.authToken.expires_in * 1000;
    } catch (error) {
      throw this.handleError(error as AxiosError);
    }
  }

  /**
   * Handle API errors consistently
   */
  private handleError(error: AxiosError): ToastError {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data as any;

      return {
        message: data?.message || error.message || 'Unknown error occurred',
        code: data?.code || `HTTP_${status}`,
        status,
        details: data,
      };
    } else if (error.request) {
      return {
        message: 'No response received from Toast API',
        code: 'NO_RESPONSE',
        details: error.message,
      };
    } else {
      return {
        message: error.message || 'Request setup failed',
        code: 'REQUEST_SETUP_ERROR',
        details: error,
      };
    }
  }

  /**
   * Generic GET request with pagination support
   */
  async get<T>(
    endpoint: string,
    params?: Record<string, any>,
    config?: AxiosRequestConfig
  ): Promise<T> {
    // Toast identifies the restaurant via the Toast-Restaurant-External-ID
    // header, not a query parameter — lift restaurantGuid out of params so
    // per-call overrides work for multi-location credentials.
    const { restaurantGuid, ...queryParams } = params || {};
    const response = await this.axiosInstance.get<T>(endpoint, {
      params: queryParams,
      ...config,
      headers: {
        ...config?.headers,
        ...(restaurantGuid
          ? { 'Toast-Restaurant-External-ID': restaurantGuid }
          : {}),
      },
    });
    return response.data;
  }

  /**
   * Generic POST request
   */
  async post<T>(
    endpoint: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const response = await this.axiosInstance.post<T>(endpoint, data, config);
    return response.data;
  }

  /**
   * Generic PUT request
   */
  async put<T>(
    endpoint: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const response = await this.axiosInstance.put<T>(endpoint, data, config);
    return response.data;
  }

  /**
   * Generic PATCH request
   */
  async patch<T>(
    endpoint: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const response = await this.axiosInstance.patch<T>(endpoint, data, config);
    return response.data;
  }

  /**
   * Generic DELETE request
   */
  async delete<T>(endpoint: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.axiosInstance.delete<T>(endpoint, config);
    return response.data;
  }

  /**
   * Paginated GET request helper
   */
  async getPaginated<T>(
    endpoint: string,
    params?: PaginationParams & Record<string, any>
  ): Promise<PaginatedResponse<T>> {
    const { page = 1, pageSize = 100, ...otherParams } = params || {};

    const response = await this.get<T[]>(endpoint, {
      page,
      pageSize,
      ...otherParams,
    });

    return {
      data: response,
      page,
      pageSize,
      hasMore: Array.isArray(response) && response.length === pageSize,
    };
  }

  /**
   * Fetch all pages of a paginated endpoint
   */
  async getAllPages<T>(
    endpoint: string,
    params?: PaginationParams & Record<string, any>
  ): Promise<T[]> {
    const allResults: T[] = [];
    const pageSize = params?.pageSize || 100;
    // Safety cap: never walk more than 60 pages (6,000 records) in one call.
    // Prevents unbounded scans from hanging clients; narrow the date range
    // for larger datasets.
    const maxPages = 60;
    // Fetch pages in small concurrent batches - order-scanning tools walk
    // dozens of pages, and serial round-trips made them unusably slow.
    const batchSize = 4;

    let page = 1;
    while (page <= maxPages) {
      const batch = Array.from(
        { length: Math.min(batchSize, maxPages - page + 1) },
        (_, i) => this.getPaginated<T>(endpoint, { ...params, page: page + i, pageSize })
      );
      const settled = await Promise.all(batch);
      let done = false;
      for (const result of settled) {
        allResults.push(...result.data);
        if (!result.hasMore) done = true;
      }
      if (done) break;
      page += batch.length;
    }

    return allResults;
  }

  /**
   * Get the restaurant GUID from config
   */
  getRestaurantGuid(): string {
    if (!this.config.restaurantGuid) {
      throw new Error('Restaurant GUID not configured');
    }
    return this.config.restaurantGuid;
  }

  /**
   * Set restaurant GUID dynamically
   */
  setRestaurantGuid(guid: string): void {
    this.config.restaurantGuid = guid;
  }

  /**
   * Get base URL
   */
  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Test connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.ensureValidToken();
      return true;
    } catch (error) {
      return false;
    }
  }
}
