defmodule Demo.Accounts do
  import Ecto.Query
  alias Demo.Repo
  alias Demo.Accounts.{User, Profile}
  require Logger
  use GenServer

  defstruct [:id, :name]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get(id) when is_binary(id) do
    Repo.get(User, id)
  end

  defp dump(user), do: Map.from_struct(user)

  defmacro debug(msg) do
    quote do
      Logger.debug(unquote(msg))
    end
  end

  defmacrop hush(_msg), do: :ok

  def ping, do: :pong
end

defprotocol Demo.Renderable do
  def render(value)
end

defimpl Demo.Renderable, for: Demo.Accounts.User do
  def render(user), do: user.name
end
