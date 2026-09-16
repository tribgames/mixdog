# Parity fixture: declaration and import shapes the graph reports for Elixir.
defmodule Acme.Store do
  @moduledoc false

  import Ecto.Query
  alias Acme.Repo
  alias Acme.Models.{User, Post}
  require Logger
  use GenServer

  defmacro debug(message) do
    quote do
      Logger.debug(unquote(message))
    end
  end

  defmacrop hush(message) do
    quote do: unquote(message)
  end

  def read(key) when is_binary(key) do
    hush(key)
    Repo.get(User, key)
  end

  def all do
    from(p in Post, select: p)
  end

  defp normalize(value), do: String.trim(value)
end

defprotocol Acme.Printable do
  def print(value)
end
