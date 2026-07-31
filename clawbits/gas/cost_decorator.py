def cost(value: int):
    """Decorator that attaches fc-computational-cost metadata to an endpoint function.

    The value is injected into the OpenAPI schema by the custom openapi() override
    in ClawBitsServer.

    Usage:
        @cost(1)
        def my_endpoint(self):
            ...
    """
    def decorator(func):
        func._computational_cost = value
        return func
    return decorator
